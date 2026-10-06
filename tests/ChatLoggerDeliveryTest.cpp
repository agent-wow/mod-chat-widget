// SPDX-License-Identifier: GPL-2.0-or-later
#include "ChatLoggerRunner.h"
#include "Chat.h"
#include "SharedDefines.h"
#include "WorldPacket.h"
#include <gtest/gtest.h>
#include <thread>
#include <unordered_set>

namespace
{
using namespace ChatLogger;
using namespace std::chrono_literals;

CapturedPacket GuildEvent(Direction direction = Direction::Incoming, uint32 account = 10)
{
    WorldPacket packet;
    if (direction == Direction::Incoming)
    {
        packet.Initialize(CMSG_MESSAGECHAT);
        packet << uint32(CHAT_MSG_GUILD) << uint32(LANG_COMMON) << "hello";
    }
    else
        ChatHandler::BuildChatPacket(packet, CHAT_MSG_GUILD, LANG_UNIVERSAL,
            ObjectGuid::Create<HighGuid::Player>(10), ObjectGuid::Empty, "hello", 0);
    CapturedPacket result;
    result.Flow = direction;
    result.Opcode = packet.GetOpcode();
    result.Bytes.assign(packet.contents(), packet.contents() + packet.size());
    result.Session = {account, ObjectGuid::Create<HighGuid::Player>(account).ToString(), "Player", "enUS"};
    return result;
}

class FakeTransport final : public ChatLogger::Transport
{
public:
    std::function<Response(std::function<bool()> const&)> Behavior;
    std::vector<std::string> Bodies;

    Response Post(std::string const& body, std::function<bool()> const& cancelled) override
    {
        Bodies.push_back(body);
        return Behavior ? Behavior(cancelled) : Response{204, 0s};
    }
};

TEST(ChatLoggerDelivery, OneSubmissionAndThreeRecipientCopiesRemainFourEvents)
{
    Counters counters;
    Limits limits;
    limits.BatchEvents = 4;
    CaptureQueue queue(limits, counters);
    Delivery delivery(queue, counters, limits, "realm-test", "boot");
    ASSERT_TRUE(queue.Push(GuildEvent()));
    for (uint32 account : {10, 20, 30})
        ASSERT_TRUE(queue.Push(GuildEvent(Direction::Outgoing, account)));
    auto body = delivery.Prepare(SteadyTime{});
    ASSERT_NE(body, nullptr);
    auto events = Json::parse(*body)["events"];
    ASSERT_EQ(events.size(), 4u);
    std::unordered_set<std::string> ids;
    unsigned incoming = 0;
    for (auto const& event : events)
    {
        EXPECT_EQ(event["text"], "hello");
        EXPECT_EQ(event["chat_type"], "GUILD");
        EXPECT_FALSE(event.contains("delivered"));
        ids.insert(event["event_id"].get<std::string>());
        incoming += event["direction"] == "incoming";
    }
    EXPECT_EQ(ids.size(), 4u);
    EXPECT_EQ(incoming, 1u);
    EXPECT_EQ(queue.Size().first, 4u); // In-flight events still occupy queue capacity.
    delivery.Complete({204, 0s}, SteadyTime{});
    EXPECT_EQ(queue.Size().first, 0u);
    EXPECT_EQ(counters.Sent[0].load(), 1u);
    EXPECT_EQ(counters.Sent[1].load(), 3u);
}

TEST(ChatLoggerDelivery, TimedFlushAndRetriesKeepExactBodyAndIds)
{
    Limits limits;
    Counters counters;
    CaptureQueue queue(limits, counters);
    Delivery delivery(queue, counters, limits, "realm", "boot");
    ASSERT_TRUE(queue.Push(GuildEvent()));
    auto start = SteadyTime{};
    EXPECT_EQ(delivery.Prepare(start), nullptr);
    EXPECT_EQ(delivery.Prepare(start + 99ms), nullptr);
    auto flushed = start + 100ms;
    auto body = delivery.Prepare(flushed);
    ASSERT_NE(body, nullptr);
    auto original = *body;
    delivery.Complete({429, 5s}, flushed);
    EXPECT_EQ(delivery.Prepare(flushed + 4s), nullptr);
    ASSERT_TRUE(queue.Push(GuildEvent()));
    auto retry = delivery.Prepare(flushed + 5s);
    ASSERT_NE(retry, nullptr);
    EXPECT_EQ(*retry, original);
    delivery.Complete({503, 0s}, flushed + 5s);
    EXPECT_EQ(delivery.Prepare(flushed + 6s), nullptr);
    EXPECT_NE(delivery.Prepare(flushed + 7s), nullptr);
    delivery.Complete({200, 0s}, flushed + 7s);
    EXPECT_EQ(queue.Size().first, 1u);
    EXPECT_EQ(counters.Retries.load(), 2u);
}

TEST(ChatLoggerDelivery, StatusPolicy)
{
    for (unsigned status : {200, 202, 204, 299})
        EXPECT_EQ(ClassifyResponse(status), ResponseAction::Acknowledge);
    for (unsigned status : {0, 408, 429, 500, 503, 599})
        EXPECT_EQ(ClassifyResponse(status), ResponseAction::Retry);
    for (unsigned status : {301, 302, 307, 400, 401, 403, 404, 413, 422})
        EXPECT_EQ(ClassifyResponse(status), ResponseAction::Reject);
}

TEST(ChatLoggerDelivery, ConcurrentProducersRespectCapacityWhileBatchIsInFlight)
{
    Limits limits;
    limits.QueueEvents = 100;
    limits.BatchEvents = 1;
    Counters counters;
    CaptureQueue queue(limits, counters);
    std::vector<std::thread> producers;
    for (int thread = 0; thread < 4; ++thread)
        producers.emplace_back([&queue]
        {
            for (int i = 0; i < 100; ++i)
                queue.Push(GuildEvent());
        });
    for (auto& producer : producers)
        producer.join();
    EXPECT_EQ(queue.Size().first, 100u);
    EXPECT_EQ(counters.Captured[0].load(), 100u);
    EXPECT_EQ(counters.Overflow[0].load(), 300u);
    std::unordered_set<std::uint64_t> sequences;
    for (auto const& packet : queue.Snapshot(100))
        sequences.insert(packet->Sequence);
    EXPECT_EQ(sequences.size(), 100u);

    Delivery delivery(queue, counters, limits, "realm", "boot");
    ASSERT_NE(delivery.Prepare(SteadyTime{}), nullptr);
    EXPECT_FALSE(queue.Push(GuildEvent()));
    delivery.Complete({400, 0s}, SteadyTime{});
    EXPECT_TRUE(queue.Push(GuildEvent()));
    EXPECT_EQ(counters.Rejected[0].load(), 1u);
}

TEST(ChatLoggerDelivery, ByteLimitAndPacketLimitCountLossByDirection)
{
    auto event = GuildEvent(Direction::Outgoing);
    Limits limits;
    limits.BatchBytes = 1024;
    limits.QueueBytes = 2 * limits.BatchBytes + event.MemorySize();
    limits.PacketBytes = event.Bytes.size();
    Counters counters;
    CaptureQueue queue(limits, counters);
    EXPECT_TRUE(queue.Push(event));
    EXPECT_FALSE(queue.Push(event));
    EXPECT_EQ(counters.Overflow[1].load(), 1u);
    event.Bytes.push_back(0);
    EXPECT_FALSE(queue.Push(event));
    EXPECT_EQ(counters.Oversized[1].load(), 1u);
    EXPECT_LE(queue.Size().second, limits.QueueBytes);
}

TEST(ChatLoggerDelivery, SerializedBatchLimitDropsOversizedHeadAndContinues)
{
    Limits limits;
    limits.BatchEvents = 3;
    limits.BatchBytes = 4096;
    Counters counters;
    CaptureQueue queue(limits, counters);
    auto large = GuildEvent();
    large.Bytes.resize(10000, 0xFF);
    ASSERT_TRUE(queue.Push(std::move(large)));
    ASSERT_TRUE(queue.Push(GuildEvent()));
    ASSERT_TRUE(queue.Push(GuildEvent()));
    Delivery delivery(queue, counters, limits, "realm", "boot");
    auto body = delivery.Prepare(SteadyTime{});
    ASSERT_NE(body, nullptr);
    EXPECT_LE(body->size(), limits.BatchBytes);
    EXPECT_EQ(Json::parse(*body)["events"].size(), 2u);
    EXPECT_EQ(counters.Oversized[0].load(), 1u);
    delivery.Complete({204, 0s}, SteadyTime{});
    EXPECT_EQ(queue.Size().first, 0u);
}

TEST(ChatLoggerDelivery, ShutdownDrainsWithoutWaitingForFlushInterval)
{
    Limits limits;
    Counters counters;
    CaptureQueue queue(limits, counters);
    Delivery delivery(queue, counters, limits, "realm", "boot");
    FakeTransport transport;
    auto now = SteadyTime{};
    Runner runner(queue, delivery, transport, [&now] { return now; });
    ASSERT_TRUE(queue.Push(GuildEvent()));
    runner.BeginShutdown();
    EXPECT_FALSE(queue.Push(GuildEvent()));
    EXPECT_TRUE(runner.Tick());
    EXPECT_FALSE(runner.Tick());
    EXPECT_EQ(transport.Bodies.size(), 1u);
    EXPECT_EQ(counters.Sent[0].load(), 1u);
    EXPECT_EQ(counters.ShutdownDropped[0].load(), 0u);
}

TEST(ChatLoggerDelivery, ShutdownCancelsBlockedTransportAtDeadline)
{
    Limits limits;
    limits.BatchEvents = 1;
    Counters counters;
    CaptureQueue queue(limits, counters);
    Delivery delivery(queue, counters, limits, "realm", "boot");
    FakeTransport transport;
    auto now = SteadyTime{};
    Runner runner(queue, delivery, transport, [&now] { return now; });
    transport.Behavior = [&](std::function<bool()> const& cancelled)
    {
        runner.BeginShutdown();
        now += 4999ms;
        EXPECT_FALSE(cancelled());
        now += 1ms;
        EXPECT_TRUE(cancelled());
        return Response{};
    };
    ASSERT_TRUE(queue.Push(GuildEvent()));
    EXPECT_FALSE(runner.Tick());
    EXPECT_EQ(counters.ShutdownDropped[0].load(), 1u);
    EXPECT_EQ(queue.Size().first, 0u);
}

TEST(ChatLoggerDelivery, ShutdownDoesNotWaitForLongRetryAfter)
{
    Limits limits;
    limits.BatchEvents = 1;
    Counters counters;
    CaptureQueue queue(limits, counters);
    Delivery delivery(queue, counters, limits, "realm", "boot");
    FakeTransport transport;
    transport.Behavior = [](auto const&) { return Response{429, 60s}; };
    auto now = SteadyTime{};
    Runner runner(queue, delivery, transport, [&now] { return now; });
    ASSERT_TRUE(queue.Push(GuildEvent()));
    EXPECT_TRUE(runner.Tick());
    runner.BeginShutdown();
    now += 5s;
    EXPECT_FALSE(runner.Tick());
    EXPECT_EQ(transport.Bodies.size(), 1u);
    EXPECT_EQ(counters.ShutdownDropped[0].load(), 1u);
}
}
