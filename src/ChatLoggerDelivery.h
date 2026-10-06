// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef MOD_CHAT_LOGGER_DELIVERY_H
#define MOD_CHAT_LOGGER_DELIVERY_H

#include "ChatLoggerEvent.h"
#include <array>
#include <atomic>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>

namespace ChatLogger
{
struct Limits
{
    std::size_t QueueEvents = 10000;
    std::size_t QueueBytes = 16 * 1024 * 1024;
    std::size_t BatchEvents = 100;
    std::size_t BatchBytes = 512 * 1024;
    std::size_t PacketBytes = 64 * 1024;
    std::chrono::milliseconds FlushInterval{100};
};

using DirectionCounts = std::array<std::atomic<std::uint64_t>, 2>;

struct Counters
{
    DirectionCounts Captured{};
    DirectionCounts Overflow{};
    DirectionCounts Oversized{};
    DirectionCounts Sent{};
    DirectionCounts Rejected{};
    DirectionCounts ShutdownDropped{};
    std::atomic<std::uint64_t> Retries{0};
    std::atomic<std::uint64_t> DecodeFailures{0};
    std::atomic<std::uint64_t> CaptureFailures{0};
};

constexpr std::size_t Index(Direction direction)
{
    return static_cast<std::size_t>(direction);
}

class CaptureQueue
{
public:
    CaptureQueue(Limits limits, Counters& counters);
    bool Push(CapturedPacket packet);
    std::vector<std::shared_ptr<CapturedPacket const>> Snapshot(std::size_t count) const;
    void Remove(std::size_t count, DirectionCounts& counter);
    void Close();
    void Discard();
    std::pair<std::size_t, std::size_t> Size() const;

private:
    Limits _limits;
    Counters& _counters;
    mutable std::mutex _mutex;
    std::deque<std::shared_ptr<CapturedPacket const>> _queue;
    std::size_t _bytes = 0;
    std::uint64_t _sequence = 0;
    bool _closed = false;
};

struct Response
{
    unsigned Status = 0; // Zero means a transport failure; response bodies are deliberately ignored.
    std::chrono::seconds RetryAfter{0};
};

enum class ResponseAction
{
    Acknowledge,
    Retry,
    Reject
};

ResponseAction ClassifyResponse(unsigned status);

// Called only by the delivery worker. Explicit time arguments keep scheduling tests deterministic.
class Delivery
{
public:
    Delivery(CaptureQueue& queue, Counters& counters, Limits limits, std::string sourceId,
        std::string processId);
    std::string const* Prepare(SteadyTime now, bool draining = false);
    void Complete(Response response, SteadyTime now);
    void Abandon();

private:
    CaptureQueue& _queue;
    Counters& _counters;
    Limits _limits;
    std::string _sourceId;
    std::string _processId;
    std::string _body;
    std::size_t _batchCount = 0;
    std::optional<SteadyTime> _firstPending;
    SteadyTime _nextAttempt{};
    std::chrono::seconds _backoff{1};
};
}

#endif
