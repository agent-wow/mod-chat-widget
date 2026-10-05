// SPDX-License-Identifier: GPL-2.0-or-later
#include "ChatLoggerRunner.h"

namespace ChatLogger
{
Runner::Runner(CaptureQueue& queue, Delivery& delivery, Transport& transport, Clock clock) :
    _queue(queue), _delivery(delivery), _transport(transport), _clock(std::move(clock)) { }

bool Runner::Expired() const
{
    return _stopping.load() && _clock().time_since_epoch().count() >= _shutdownAt.load();
}

bool Runner::Tick()
{
    _lastResponse.reset();
    if (Expired() || (_stopping.load() && !_queue.Size().first))
    {
        _delivery.Abandon();
        return false;
    }
    if (auto body = _delivery.Prepare(_clock(), _stopping.load()))
    {
        auto response = _transport.Post(*body, [this] { return Expired(); });
        // A request interrupted at the drain deadline has no acknowledgement.
        if (Expired() && !response.Status)
        {
            _delivery.Abandon();
            return false;
        }
        _lastResponse = response;
        _delivery.Complete(response, _clock());
    }
    return true;
}

void Runner::BeginShutdown()
{
    _queue.Close();
    _shutdownAt.store((_clock() + std::chrono::seconds(5)).time_since_epoch().count());
    _stopping.store(true);
}

void Runner::Abort()
{
    _delivery.Abandon();
}
}
