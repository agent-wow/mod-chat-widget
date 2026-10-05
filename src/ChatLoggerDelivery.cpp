// SPDX-License-Identifier: GPL-2.0-or-later
#include "ChatLoggerDelivery.h"
#include <algorithm>
#include <stdexcept>

namespace ChatLogger
{
CaptureQueue::CaptureQueue(Limits limits, Counters& counters) : _limits(limits), _counters(counters)
{
    if (!_limits.QueueEvents || !_limits.BatchEvents || !_limits.PacketBytes ||
        _limits.BatchBytes < 1024 || _limits.BatchBytes >= _limits.QueueBytes / 2 ||
        _limits.FlushInterval.count() <= 0)
        throw std::invalid_argument("invalid queue limits");
}

bool CaptureQueue::Push(CapturedPacket packet)
{
    auto index = Index(packet.Flow);
    if (packet.Bytes.size() > _limits.PacketBytes)
    {
        ++_counters.Oversized[index];
        return false;
    }
    auto size = packet.MemorySize();
    std::lock_guard lock(_mutex);
    if (_closed)
        return false;
    // Reserve the serialized batch and the HTTP request copy in addition to retained packets.
    auto capacity = _limits.QueueBytes - 2 * _limits.BatchBytes;
    if (_queue.size() >= _limits.QueueEvents || size > capacity - _bytes)
    {
        ++_counters.Overflow[index];
        return false;
    }
    packet.Sequence = ++_sequence;
    auto entry = std::make_shared<CapturedPacket const>(std::move(packet));
    _queue.push_back(std::move(entry));
    _bytes += size;
    ++_counters.Captured[index];
    return true;
}

std::vector<std::shared_ptr<CapturedPacket const>> CaptureQueue::Snapshot(std::size_t count) const
{
    std::lock_guard lock(_mutex);
    count = std::min(count, _queue.size());
    return {_queue.begin(), _queue.begin() + count};
}

void CaptureQueue::Remove(std::size_t count, DirectionCounts& counter)
{
    std::lock_guard lock(_mutex);
    while (count-- && !_queue.empty())
    {
        auto const& packet = *_queue.front();
        _bytes -= packet.MemorySize();
        ++counter[Index(packet.Flow)];
        _queue.pop_front();
    }
}

void CaptureQueue::Close()
{
    std::lock_guard lock(_mutex);
    _closed = true;
}

void CaptureQueue::Discard()
{
    Remove(_limits.QueueEvents, _counters.ShutdownDropped);
}

std::pair<std::size_t, std::size_t> CaptureQueue::Size() const
{
    std::lock_guard lock(_mutex);
    return {_queue.size(), _bytes + 2 * _limits.BatchBytes};
}

ResponseAction ClassifyResponse(unsigned status)
{
    if (status >= 200 && status < 300)
        return ResponseAction::Acknowledge;
    if (!status || status == 408 || status == 429 || (status >= 500 && status < 600))
        return ResponseAction::Retry;
    return ResponseAction::Reject;
}

Delivery::Delivery(CaptureQueue& queue, Counters& counters, Limits limits, std::string sourceId,
    std::string processId) : _queue(queue), _counters(counters), _limits(limits),
    _sourceId(std::move(sourceId)), _processId(std::move(processId))
{
    _body.reserve(_limits.BatchBytes);
}

std::string const* Delivery::Prepare(SteadyTime now, bool draining)
{
    if (_batchCount)
        return now >= _nextAttempt ? &_body : nullptr;

    auto packets = _queue.Snapshot(_limits.BatchEvents);
    if (packets.empty())
    {
        _firstPending.reset();
        return nullptr;
    }
    if (!_firstPending)
        _firstPending = now;
    if (!draining && packets.size() < _limits.BatchEvents && now - *_firstPending < _limits.FlushInterval)
        return nullptr;

    // Serialize events separately to enforce the exact encoded HTTP body limit.
    _body.clear();
    _body += "{\"schema_version\":1,\"source_id\":";
    _body += Json(_sourceId).dump();
    _body += ",\"events\":[";
    for (auto const& packet : packets)
    {
        auto event = Decode(*packet, _processId);
        bool malformed = event["decoding_status"] != "ok";
        auto serialized = event.dump(-1, ' ', false, Json::error_handler_t::replace);
        if (_body.size() + serialized.size() + (_batchCount ? 1 : 0) + 2 > _limits.BatchBytes)
        {
            if (_batchCount)
                break;
            _queue.Remove(1, _counters.Oversized);
            if (malformed)
                ++_counters.DecodeFailures;
            continue;
        }
        if (_batchCount)
            _body += ',';
        _body += serialized;
        ++_batchCount;
        if (malformed)
            ++_counters.DecodeFailures;
    }
    _firstPending.reset();
    if (!_batchCount)
    {
        _body.clear();
        return nullptr;
    }
    _body += "]}";
    return &_body;
}

void Delivery::Complete(Response response, SteadyTime now)
{
    if (!_batchCount)
        return;
    auto action = ClassifyResponse(response.Status);
    if (action == ResponseAction::Retry)
    {
        ++_counters.Retries;
        auto delay = std::max(_backoff, std::clamp(response.RetryAfter,
            std::chrono::seconds(0), std::chrono::seconds(60)));
        _nextAttempt = now + delay;
        _backoff = std::min(_backoff * 2, std::chrono::seconds(60));
        return;
    }
    _queue.Remove(_batchCount, action == ResponseAction::Acknowledge ? _counters.Sent : _counters.Rejected);
    _batchCount = 0;
    _body.clear();
    _backoff = std::chrono::seconds(1);
    _nextAttempt = now;
}

void Delivery::Abandon()
{
    _body.clear();
    _batchCount = 0;
    _queue.Close();
    _queue.Discard();
}
}
