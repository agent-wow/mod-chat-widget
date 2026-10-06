// SPDX-License-Identifier: GPL-2.0-or-later
#include "ChatLoggerEvent.h"
#include "Chat.h"
#include "Channel.h"
#include "SharedDefines.h"
#include "WorldPacket.h"
#include <gtest/gtest.h>

namespace
{
using namespace ChatLogger;

CapturedPacket Capture(WorldPacket const& packet, Direction direction = Direction::Incoming,
    std::uint32_t account = 10)
{
    CapturedPacket result;
    result.Flow = direction;
    result.Opcode = packet.GetOpcode();
    result.Session = {account, ObjectGuid::Create<HighGuid::Player>(account).ToString(), "Alice", "enUS", {}, {}};
    result.Sequence = 1;
    if (!packet.empty())
        result.Bytes.assign(packet.contents(), packet.contents() + packet.size());
    return result;
}

WorldPacket Submission(ChatMsg type, std::string const& text, std::string const& target = "")
{
    WorldPacket packet(CMSG_MESSAGECHAT);
    packet << uint32(type) << uint32(LANG_COMMON);
    if (type == CHAT_MSG_WHISPER || type == CHAT_MSG_CHANNEL)
        packet << target;
    packet << text;
    return packet;
}

TEST(ChatLoggerEvent, PresenceAndChatShareTheLoginBoundary)
{
    auto packet = Capture(Submission(CHAT_MSG_SAY, "hello"));
    packet.Session.LoginId = "11111111-1111-4111-8111-111111111111";
    packet.Session.StartedAt = "2026-10-06T12:00:00.000Z";
    auto chat = Decode(packet, "process");
    EXPECT_EQ(chat["session"]["login_id"], packet.Session.LoginId);
    EXPECT_EQ(chat["session"]["started_at"], packet.Session.StartedAt);
    packet.Flow = Direction::Outgoing;
    packet.Bytes.clear();
    for (auto state : {"online", "unavailable", "offline"})
    {
        packet.Presence = state;
        auto event = Decode(packet, "process");
        EXPECT_EQ(event["event_kind"], "presence");
        EXPECT_EQ(event["observation"], "character_presence");
        EXPECT_EQ(event["presence"], state);
        EXPECT_EQ(event["sequence"], "1");
        EXPECT_EQ(event["session"], chat["session"]);
        EXPECT_TRUE(event["opcode"].is_null());
        EXPECT_TRUE(event["opcode_id"].is_null());
        EXPECT_EQ(event["decoding_status"], "ok");
    }
}

TEST(ChatLoggerEvent, IncomingTypesPreserveOriginalTextAndSession)
{
    for (auto type : {CHAT_MSG_SAY, CHAT_MSG_YELL, CHAT_MSG_EMOTE, CHAT_MSG_PARTY, CHAT_MSG_PARTY_LEADER,
        CHAT_MSG_RAID, CHAT_MSG_RAID_LEADER, CHAT_MSG_RAID_WARNING, CHAT_MSG_GUILD, CHAT_MSG_OFFICER,
        CHAT_MSG_BATTLEGROUND, CHAT_MSG_BATTLEGROUND_LEADER, CHAT_MSG_AFK, CHAT_MSG_DND})
    {
        auto packet = Submission(type, "hello  世界\nsecond line");
        packet.rpos(2);
        auto event = Decode(Capture(packet), "process");
        EXPECT_EQ(event["text"], "hello  世界\nsecond line");
        EXPECT_EQ(event["chat_type_id"], type);
        EXPECT_EQ(event["sender"]["name"], "Alice");
        EXPECT_EQ(event["observation"], "client_submission");
        EXPECT_EQ(event["decoding_status"], "ok");
        EXPECT_EQ(packet.rpos(), 2u);
    }
}

TEST(ChatLoggerEvent, CommandsWhispersAndChannelsKeepUnresolvedTargets)
{
    EXPECT_EQ(Decode(Capture(Submission(CHAT_MSG_SAY, ".help")), "p")["text"], ".help");
    auto whisper = Decode(Capture(Submission(CHAT_MSG_WHISPER, "hello", "Offlinebob")), "p");
    EXPECT_EQ(whisper["target"]["name"], "Offlinebob");
    EXPECT_TRUE(whisper["target"]["guid"].is_null());
    auto channel = Decode(Capture(Submission(CHAT_MSG_CHANNEL, "hello", "world")), "p");
    EXPECT_EQ(channel["channel"], "world");
}

TEST(ChatLoggerEvent, DecodesCoreOutgoingPacketLayoutsWithoutMutatingPacket)
{
    auto sender = ObjectGuid::Create<HighGuid::Player>(10);
    auto target = ObjectGuid::Create<HighGuid::Player>(20);
    auto creature = ObjectGuid::Create<HighGuid::Unit>(123, 1);
    for (auto type : {CHAT_MSG_SAY, CHAT_MSG_GUILD, CHAT_MSG_OFFICER, CHAT_MSG_PARTY, CHAT_MSG_RAID,
        CHAT_MSG_BATTLEGROUND, CHAT_MSG_WHISPER, CHAT_MSG_WHISPER_INFORM, CHAT_MSG_AFK, CHAT_MSG_DND,
        CHAT_MSG_SYSTEM, CHAT_MSG_CHANNEL, CHAT_MSG_MONSTER_SAY, CHAT_MSG_MONSTER_YELL,
        CHAT_MSG_MONSTER_WHISPER, CHAT_MSG_RAID_BOSS_EMOTE, CHAT_MSG_RAID_BOSS_WHISPER,
        CHAT_MSG_WHISPER_FOREIGN, CHAT_MSG_BG_SYSTEM_ALLIANCE, CHAT_MSG_ACHIEVEMENT,
        CHAT_MSG_GUILD_ACHIEVEMENT})
    {
        for (bool gm : {false, true})
        {
            WorldPacket packet;
            ChatHandler::BuildChatPacket(packet, type, LANG_COMMON, sender, creature,
                "|cffffffffHello 世界|r", 0, "Alice", "Creature", 42, gm, "world");
            auto before = Capture(packet, Direction::Outgoing);
            auto event = Decode(before, "p");
            EXPECT_EQ(event["decoding_status"], "ok") << int(type) << " GM=" << gm;
            EXPECT_EQ(event["text"], "|cffffffffHello 世界|r");
            EXPECT_EQ(event["sender"]["guid"], sender.ToString());
            EXPECT_EQ(event["target"]["guid"], creature.ToString());
            EXPECT_EQ(event["session"]["account_id"], 10);
            EXPECT_EQ(Capture(packet).Bytes, before.Bytes);
            EXPECT_EQ(packet.rpos(), 0u);
        }
    }
    WorldPacket whisper;
    ChatHandler::BuildChatPacket(whisper, CHAT_MSG_WHISPER, LANG_COMMON, sender, target, "private", 0);
    EXPECT_EQ(Decode(Capture(whisper, Direction::Outgoing), "p")["target"]["guid"], target.ToString());
}

TEST(ChatLoggerEvent, SelectsOnlyChatPacketsAndExcludesAddonLanguage)
{
    EXPECT_FALSE(IsSelectedPacket(Direction::Incoming, CMSG_EMOTE));
    EXPECT_FALSE(IsSelectedPacket(Direction::Outgoing, SMSG_EMOTE));
    EXPECT_FALSE(IsSelectedPacket(Direction::Incoming, CMSG_PING));
    EXPECT_FALSE(IsSelectedPacket(Direction::Outgoing, CMSG_MESSAGECHAT));
    EXPECT_FALSE(IsSelectedPacket(Direction::Incoming, SMSG_MESSAGECHAT));
    auto input = Submission(CHAT_MSG_GUILD, "addon\tpayload");
    input.put<uint32>(4, LANG_ADDON);
    EXPECT_TRUE(IsAddonPacket(input.GetOpcode(), Capture(input).Bytes));
    for (bool gm : {false, true})
    {
        WorldPacket output;
        ChatHandler::BuildChatPacket(output, CHAT_MSG_GUILD, LANG_ADDON,
            ObjectGuid::Create<HighGuid::Player>(1), ObjectGuid::Empty, "addon\tpayload", 0, "Alice", "", 0, gm);
        EXPECT_TRUE(IsAddonPacket(output.GetOpcode(), Capture(output).Bytes));
    }
    EXPECT_FALSE(IsAddonPacket(CMSG_MESSAGECHAT, {}));
    EXPECT_TRUE(IsSelectedPacket(Direction::Outgoing, SMSG_DEFENSE_MESSAGE));
}

TEST(ChatLoggerEvent, MalformedDataPreservesBytesWithoutPoisoningJson)
{
    auto valid = Capture(Submission(CHAT_MSG_SAY, "hello"));
    for (std::size_t size = 0; size < valid.Bytes.size(); ++size)
    {
        auto packet = valid;
        packet.Bytes.resize(size);
        auto event = Decode(packet, "p");
        EXPECT_EQ(event["decoding_status"], "malformed");
        EXPECT_TRUE(event["raw_packet_base64"].is_string());
        EXPECT_NO_THROW(event.dump());
    }
    valid.Bytes[8] = 0xFF;
    auto invalidUtf8 = Decode(valid, "p");
    EXPECT_EQ(invalidUtf8["decoding_status"], "malformed");
    EXPECT_NO_THROW(invalidUtf8.dump());

    auto trailing = Capture(Submission(CHAT_MSG_SAY, "hello"));
    trailing.Bytes.push_back(0xFF);
    EXPECT_EQ(Decode(trailing, "p")["decoding_status"], "trailing_bytes");
    auto unknown = Capture(Submission(CHAT_MSG_SAY, "hello"));
    unknown.Bytes[0] = 0xFE;
    EXPECT_EQ(Decode(unknown, "p")["decoding_status"], "unsupported");
}

TEST(ChatLoggerEvent, TextEmotesPreserveIdentifiersAndLocalizedTargetNames)
{
    WorldPacket incoming(CMSG_TEXT_EMOTE);
    incoming << uint32(17) << uint32(0) << ObjectGuid::Create<HighGuid::Player>(20);
    auto event = Decode(Capture(incoming), "p");
    EXPECT_EQ(event["event_kind"], "text_emote");
    EXPECT_EQ(event["emote"]["id"], 17);
    EXPECT_EQ(event["target"]["guid"], ObjectGuid::Create<HighGuid::Player>(20).ToString());

    WorldPacket outgoing(SMSG_TEXT_EMOTE);
    std::string name = "Élodie";
    outgoing << ObjectGuid::Create<HighGuid::Player>(10) << uint32(17) << uint32(0);
    outgoing << uint32(name.size()) << name;
    auto captured = Capture(outgoing, Direction::Outgoing);
    captured.Session.Locale = "frFR";
    auto localized = Decode(captured, "p");
    EXPECT_EQ(localized["target"]["name"], name);
    EXPECT_EQ(localized["session"]["locale"], "frFR");
    EXPECT_TRUE(localized["text"].is_null());
}

TEST(ChatLoggerEvent, DecodesChannelAndServerNotices)
{
    WorldPacket joined(SMSG_CHANNEL_NOTIFY);
    joined << uint8(CHAT_JOINED_NOTICE) << "world" << ObjectGuid::Create<HighGuid::Player>(20);
    auto join = Decode(Capture(joined, Direction::Outgoing), "p");
    EXPECT_EQ(join["channel"], "world");
    EXPECT_EQ(join["notice"]["id"], CHAT_JOINED_NOTICE);
    EXPECT_EQ(join["decoding_status"], "ok");

    WorldPacket listing(SMSG_CHANNEL_LIST);
    listing << uint8(1) << "world" << uint8(0) << uint32(1);
    listing << ObjectGuid::Create<HighGuid::Player>(20) << uint8(0);
    EXPECT_EQ(Decode(Capture(listing, Direction::Outgoing), "p")["notice"]["members"].size(), 1u);

    WorldPacket motd(SMSG_MOTD);
    motd << uint32(2) << "Welcome" << "Bienvenue";
    EXPECT_EQ(Decode(Capture(motd, Direction::Outgoing), "p")["notice"]["lines"],
        Json::array({"Welcome", "Bienvenue"}));

    WorldPacket notification(SMSG_NOTIFICATION);
    notification << "You are muted";
    EXPECT_EQ(Decode(Capture(notification, Direction::Outgoing), "p")["text"], "You are muted");

    WorldPacket unknown(SMSG_DEFENSE_MESSAGE);
    unknown << uint32(42);
    EXPECT_EQ(Decode(Capture(unknown, Direction::Outgoing), "p")["decoding_status"], "unsupported");
}

TEST(ChatLoggerEvent, UtcTimestampIncludesMilliseconds)
{
    EXPECT_EQ(FormatTimestamp(std::chrono::system_clock::time_point{} + std::chrono::milliseconds(123)),
        "1970-01-01T00:00:00.123Z");
}
}
