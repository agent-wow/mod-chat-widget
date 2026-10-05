// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef MOD_CHAT_LOGGER_HTTP_H
#define MOD_CHAT_LOGGER_HTTP_H

#include "ChatLoggerDelivery.h"
#include <functional>
#include <string_view>

namespace ChatLogger
{
struct Endpoint
{
    bool Tls = false;
    std::string Host;
    std::string Port;
    std::string Authority;
    std::string Target;
};

Endpoint ParseEndpoint(std::string const& url);
std::chrono::seconds ParseRetryAfter(std::string const& value, std::chrono::system_clock::time_point now);

struct HttpOptions
{
    Endpoint Destination;
    std::string BearerToken;
    std::string CaFile;
    std::chrono::milliseconds ConnectTimeout{3000};
    std::chrono::milliseconds RequestTimeout{5000};
};

class Transport
{
public:
    virtual ~Transport() = default;
    virtual Response Post(std::string const& body, std::function<bool()> const& cancelled) = 0;
};

std::unique_ptr<Transport> MakeHttpTransport(HttpOptions options);
}

#endif
