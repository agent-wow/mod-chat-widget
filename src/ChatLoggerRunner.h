// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef MOD_CHAT_LOGGER_RUNNER_H
#define MOD_CHAT_LOGGER_RUNNER_H

#include "ChatLoggerHttp.h"

namespace ChatLogger
{
// The clock and transport are injected; tests can advance deadlines without sleeping or networking.
class Runner
{
public:
    using Clock = std::function<SteadyTime()>;
    Runner(CaptureQueue& queue, Delivery& delivery, Transport& transport, Clock clock);
    bool Tick();
    void BeginShutdown();
    void Abort();
    std::optional<Response> LastResponse() const { return _lastResponse; }

private:
    bool Expired() const;
    CaptureQueue& _queue;
    Delivery& _delivery;
    Transport& _transport;
    Clock _clock;
    std::atomic<bool> _stopping{false};
    std::atomic<SteadyTime::duration::rep> _shutdownAt{0};
    std::optional<Response> _lastResponse;
};
}

#endif
