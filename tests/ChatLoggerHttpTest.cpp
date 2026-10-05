// SPDX-License-Identifier: GPL-2.0-or-later
#include "ChatLoggerHttp.h"
#include <boost/asio.hpp>
#include <boost/asio/ssl.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/core/flat_buffer.hpp>
#include <gtest/gtest.h>
#include <filesystem>
#include <thread>

namespace
{
using namespace ChatLogger;
using namespace std::chrono_literals;
namespace Asio = boost::asio;
namespace Http = boost::beast::http;
using Tcp = Asio::ip::tcp;

class LoopbackServer
{
public:
    explicit LoopbackServer(std::string response) : _acceptor(_context), _socket(_context),
        _response(std::move(response))
    {
        _acceptor.open(Tcp::v4());
        _acceptor.bind({Asio::ip::make_address("127.0.0.1"), 0});
        _acceptor.listen();
        _acceptor.async_accept(_socket, [this](boost::system::error_code error)
        {
            if (error)
                return;
            Http::async_read(_socket, _buffer, Received, [this](boost::system::error_code readError, std::size_t)
            {
                if (readError || _response.empty())
                    return;
                Asio::async_write(_socket, Asio::buffer(_response), [](boost::system::error_code, std::size_t) { });
            });
        });
        _thread = std::thread([this] { _context.run(); });
    }

    ~LoopbackServer() { Stop(); }

    void Stop()
    {
        _context.stop();
        if (_thread.joinable())
            _thread.join();
    }

    std::string Url() const
    {
        return "http://127.0.0.1:" + std::to_string(_acceptor.local_endpoint().port()) + "/chat?source=test";
    }

    Http::request<Http::string_body> Received;

private:
    Asio::io_context _context;
    Tcp::acceptor _acceptor;
    Tcp::socket _socket;
    boost::beast::flat_buffer _buffer;
    std::string _response;
    std::thread _thread;
};

std::string Fixture(char const* name)
{
    return (std::filesystem::path(__FILE__).parent_path() / "fixtures" / name).string();
}

Asio::ssl::context ServerContext()
{
    Asio::ssl::context context(Asio::ssl::context::tls_server);
    context.use_certificate_chain_file(Fixture("server-cert.pem"));
    context.use_private_key_file(Fixture("server-key.pem"), Asio::ssl::context::pem);
    return context;
}

class TlsServer
{
public:
    TlsServer() : _ssl(ServerContext()),
        _acceptor(_context, {Asio::ip::make_address("127.0.0.1"), 0}), _stream(_context, _ssl)
    {
        _acceptor.async_accept(_stream.next_layer(), [this](boost::system::error_code error)
        {
            if (error)
                return;
            _stream.async_handshake(Asio::ssl::stream_base::server, [this](boost::system::error_code handshakeError)
            {
                if (handshakeError)
                    return;
                Http::async_read(_stream, _buffer, _request,
                    [this](boost::system::error_code readError, std::size_t)
                    {
                        if (readError)
                            return;
                        Asio::async_write(_stream, Asio::buffer(_response),
                            [](boost::system::error_code, std::size_t) { });
                    });
            });
        });
        _thread = std::thread([this] { _context.run(); });
    }

    ~TlsServer()
    {
        _context.stop();
        if (_thread.joinable())
            _thread.join();
    }

    std::string Url(char const* host = "127.0.0.1") const
    {
        return "https://" + std::string(host) + ":" + std::to_string(_acceptor.local_endpoint().port()) + "/chat";
    }

private:
    Asio::io_context _context;
    Asio::ssl::context _ssl;
    Tcp::acceptor _acceptor;
    Asio::ssl::stream<Tcp::socket> _stream;
    boost::beast::flat_buffer _buffer;
    Http::request<Http::string_body> _request;
    std::string _response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
    std::thread _thread;
};

TEST(ChatLoggerHttp, EndpointParsingAndInvalidConfiguration)
{
    auto endpoint = ParseEndpoint("https://example.org:8443/chat?q=1");
    EXPECT_TRUE(endpoint.Tls);
    EXPECT_EQ(endpoint.Host, "example.org");
    EXPECT_EQ(endpoint.Port, "8443");
    EXPECT_EQ(endpoint.Target, "/chat?q=1");
    EXPECT_EQ(ParseEndpoint("http://[::1]:8080/chat").Host, "::1");
    EXPECT_EQ(ParseEndpoint("http://localhost?query=1").Target, "/?query=1");
    for (auto url : {"", "ftp://host/chat", "https://user:password@host/chat", "https://host/#fragment",
        "https://host\r\nInjected:header", "https://host:", "https://host:65536", "https://[broken]/"})
        EXPECT_THROW(ParseEndpoint(url), std::invalid_argument);
    HttpOptions options;
    options.Destination = ParseEndpoint("http://localhost/");
    options.BearerToken = "bad\r\nheader";
    EXPECT_THROW(MakeHttpTransport(options), std::invalid_argument);
}

TEST(ChatLoggerHttp, RetryAfterSupportsSecondsAndHttpDatesWithCap)
{
    auto epoch = std::chrono::system_clock::time_point{};
    EXPECT_EQ(ParseRetryAfter("45", epoch), 45s);
    EXPECT_EQ(ParseRetryAfter("999999999999999999999999", epoch), 60s);
    EXPECT_EQ(ParseRetryAfter("-1", epoch), 0s);
    EXPECT_EQ(ParseRetryAfter("invalid", epoch), 0s);
    EXPECT_EQ(ParseRetryAfter("Thu, 01 Jan 1970 00:00:30 GMT", epoch), 30s);
    EXPECT_EQ(ParseRetryAfter("Thu, 01 Jan 1970 00:00:30 GMT", epoch + 31s), 0s);
}

TEST(ChatLoggerHttp, SendsJsonAuthorizationAndParsesAcknowledgement)
{
    LoopbackServer server("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n");
    HttpOptions options;
    options.Destination = ParseEndpoint(server.Url());
    options.BearerToken = "test-token";
    auto transport = MakeHttpTransport(options);
    auto result = transport->Post("{\"schema_version\":1,\"events\":[]}", [] { return false; });
    server.Stop();
    EXPECT_EQ(result.Status, 204u);
    EXPECT_EQ(server.Received.method(), Http::verb::post);
    EXPECT_EQ(server.Received.target(), "/chat?source=test");
    EXPECT_EQ(server.Received[Http::field::content_type], "application/json");
    EXPECT_EQ(server.Received[Http::field::authorization], "Bearer test-token");
    EXPECT_EQ(Json::parse(server.Received.body())["schema_version"], 1);
}

TEST(ChatLoggerHttp, ReturnsRedirectWithoutFollowingItAndHonorsRetryAfter)
{
    for (auto status : {302, 429, 503})
    {
        LoopbackServer server("HTTP/1.1 " + std::to_string(status) + " Status\r\n"
            "Location: http://127.0.0.1:1/must-not-follow\r\nRetry-After: 9\r\nContent-Length: 0\r\n\r\n");
        HttpOptions options;
        options.Destination = ParseEndpoint(server.Url());
        auto result = MakeHttpTransport(options)->Post("{}", [] { return false; });
        EXPECT_EQ(result.Status, unsigned(status));
        EXPECT_EQ(result.RetryAfter, 9s);
    }
}

TEST(ChatLoggerHttp, SkipsInformationalResponsesUntilFinalAcknowledgement)
{
    LoopbackServer server("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\n\r\n");
    HttpOptions options;
    options.Destination = ParseEndpoint(server.Url());
    EXPECT_EQ(MakeHttpTransport(options)->Post("{}", [] { return false; }).Status, 204u);
}

TEST(ChatLoggerHttp, SlowResponseAndShutdownCancellationReturnTransportFailure)
{
    LoopbackServer server("");
    HttpOptions options;
    options.Destination = ParseEndpoint(server.Url());
    options.ConnectTimeout = 100ms;
    options.RequestTimeout = 150ms;
    auto transport = MakeHttpTransport(options);
    auto start = std::chrono::steady_clock::now();
    EXPECT_EQ(transport->Post("{}", [] { return false; }).Status, 0u);
    EXPECT_LT(std::chrono::steady_clock::now() - start, 2s);

    unsigned polls = 0;
    EXPECT_EQ(transport->Post("{}", [&polls] { return ++polls >= 3; }).Status, 0u);
}

TEST(ChatLoggerHttp, TlsRequiresTrustedCertificateAndMatchingHostname)
{
    {
        TlsServer server;
        HttpOptions options;
        options.Destination = ParseEndpoint(server.Url());
        EXPECT_EQ(MakeHttpTransport(options)->Post("{}", [] { return false; }).Status, 0u);
    }
    {
        TlsServer server;
        HttpOptions options;
        options.Destination = ParseEndpoint(server.Url());
        options.CaFile = Fixture("server-cert.pem");
        EXPECT_EQ(MakeHttpTransport(options)->Post("{}", [] { return false; }).Status, 204u);
    }
    {
        TlsServer server;
        HttpOptions options;
        options.Destination = ParseEndpoint(server.Url("localhost"));
        options.CaFile = Fixture("server-cert.pem");
        EXPECT_EQ(MakeHttpTransport(options)->Post("{}", [] { return false; }).Status, 0u);
    }
}
}
