// SPDX-License-Identifier: GPL-2.0-or-later
#include "ChatLoggerHttp.h"
#include <boost/asio/connect.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/ssl.hpp>
#include <boost/asio/steady_timer.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/ssl.hpp>
#include <openssl/ssl.h>
#include <algorithm>
#include <charconv>
#include <ctime>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace ChatLogger
{
namespace
{
namespace Asio = boost::asio;
namespace Beast = boost::beast;
namespace Http = boost::beast::http;
using Tcp = Asio::ip::tcp;
using Error = boost::system::error_code;

bool HasControlOrSpace(std::string_view value)
{
    return std::any_of(value.begin(), value.end(), [](unsigned char c) { return c <= 32 || c == 127; });
}

class Request : public std::enable_shared_from_this<Request>
{
public:
    Request(Asio::io_context& context, Asio::ssl::context& ssl, HttpOptions const& options,
        std::string const& body) : _resolver(context), _stream(context, ssl), _deadline(context),
        _connectDeadline(context), _options(options)
    {
        _request.version(11);
        _request.method(Http::verb::post);
        _request.target(_options.Destination.Target);
        _request.set(Http::field::host, _options.Destination.Authority);
        _request.set(Http::field::content_type, "application/json");
        _request.set(Http::field::user_agent, "AzerothCore-mod-chat-widget/1");
        _request.keep_alive(false);
        if (!_options.BearerToken.empty())
            _request.set(Http::field::authorization, "Bearer " + _options.BearerToken);
        _request.body() = body;
        _request.prepare_payload();
        ResetParser();
    }

    void Start()
    {
        auto self = shared_from_this();
        _deadline.expires_after(_options.RequestTimeout);
        _deadline.async_wait([self](Error error)
        {
            if (!error)
                self->Finish({});
        });
        _connectDeadline.expires_after(_options.ConnectTimeout);
        _connectDeadline.async_wait([self](Error error)
        {
            if (!error)
                self->Finish({});
        });
        _resolver.async_resolve(_options.Destination.Host, _options.Destination.Port,
            [self](Error error, Tcp::resolver::results_type results)
            {
                if (self->Done)
                    return;
                if (error)
                    return self->Finish({});
                Beast::get_lowest_layer(self->_stream).async_connect(results,
                    [self](Error connectError, Tcp::endpoint const&)
                    {
                        if (self->Done)
                            return;
                        if (connectError)
                            return self->Finish({});
                        self->Handshake();
                    });
            });
    }

    void Finish(Response response)
    {
        if (Done)
            return;
        Result = response;
        Done = true;
        _resolver.cancel();
        _deadline.cancel();
        _connectDeadline.cancel();
        Error ignored;
        Beast::get_lowest_layer(_stream).socket().cancel(ignored);
        Beast::get_lowest_layer(_stream).socket().close(ignored);
        // Closing rather than waiting for TLS close_notify keeps shutdown bounded by our deadline.
    }

    bool Done = false;
    Response Result;

private:
    void ResetParser()
    {
        _parser = std::make_unique<Http::response_parser<Http::empty_body>>();
        _parser->header_limit(16 * 1024);
        _parser->skip(true);
    }

    void Handshake()
    {
        if (!_options.Destination.Tls)
        {
            _connectDeadline.cancel();
            Write();
            return;
        }
        _stream.set_verify_mode(Asio::ssl::verify_peer);
        _stream.set_verify_callback(Asio::ssl::host_name_verification(_options.Destination.Host));
        if (!SSL_set_tlsext_host_name(_stream.native_handle(), _options.Destination.Host.c_str()))
            return Finish({});
        auto self = shared_from_this();
        _stream.async_handshake(Asio::ssl::stream_base::client, [self](Error error)
        {
            if (self->Done)
                return;
            if (error)
                return self->Finish({});
            self->_connectDeadline.cancel();
            self->Write();
        });
    }

    void Write()
    {
        auto self = shared_from_this();
        auto callback = [self](Error error, std::size_t)
        {
            if (self->Done)
                return;
            if (error)
                return self->Finish({});
            self->Read();
        };
        if (_options.Destination.Tls)
            Http::async_write(_stream, _request, callback);
        else
            Http::async_write(Beast::get_lowest_layer(_stream), _request, callback);
    }

    void Read()
    {
        auto self = shared_from_this();
        auto callback = [self](Error error, std::size_t)
        {
            if (self->Done)
                return;
            if (error)
                return self->Finish({});
            auto const& reply = self->_parser->get();
            if (reply.result_int() >= 100 && reply.result_int() < 200 && reply.result_int() != 101)
            {
                if (++self->_interimHeaders > 8)
                    return self->Finish({});
                self->ResetParser();
                self->Read();
                return;
            }
            auto retry = reply[Http::field::retry_after];
            self->Finish({reply.result_int(), ParseRetryAfter(std::string(retry.data(), retry.size()),
                std::chrono::system_clock::now())});
        };
        if (_options.Destination.Tls)
            Http::async_read_header(_stream, _buffer, *_parser, callback);
        else
            Http::async_read_header(Beast::get_lowest_layer(_stream), _buffer, *_parser, callback);
    }

    Tcp::resolver _resolver;
    Beast::ssl_stream<Beast::tcp_stream> _stream;
    Asio::steady_timer _deadline;
    Asio::steady_timer _connectDeadline;
    HttpOptions const& _options;
    Http::request<Http::string_body> _request;
    std::unique_ptr<Http::response_parser<Http::empty_body>> _parser;
    Beast::flat_buffer _buffer{32 * 1024};
    unsigned _interimHeaders = 0;
};

class HttpTransport final : public Transport
{
public:
    explicit HttpTransport(HttpOptions options) : _options(std::move(options)),
        _ssl(Asio::ssl::context::tls_client)
    {
        if (_options.ConnectTimeout.count() <= 0 || _options.RequestTimeout < _options.ConnectTimeout ||
            _options.RequestTimeout > std::chrono::seconds(60) || _options.BearerToken.size() > 4096 ||
            HasControlOrSpace(_options.BearerToken))
            throw std::invalid_argument("invalid HTTP settings");
        if (_options.Destination.Tls)
        {
            _ssl.set_default_verify_paths();
            if (!_options.CaFile.empty())
                _ssl.load_verify_file(_options.CaFile);
        }
    }

    Response Post(std::string const& body, std::function<bool()> const& cancelled) override
    {
        _context.restart();
        _context.poll();
        // An OS DNS lookup can finish after cancellation. Never pile up resolvers/payloads behind it.
        if (_active && _active.use_count() > 1)
            return {};
        _active.reset();
        if (cancelled())
            return {};
        _context.restart();
        _active = std::make_shared<Request>(_context, _ssl, _options, body);
        try
        {
            _active->Start();
            while (!_active->Done)
            {
                if (cancelled())
                    _active->Finish({});
                _context.run_for(std::chrono::milliseconds(10));
            }
            _context.poll();
        }
        catch (std::exception const&)
        {
            _active->Finish({});
            _context.poll();
        }
        return _active->Result;
    }

private:
    // Destroy context (and its outstanding callbacks) before SSL/options referenced by callbacks.
    HttpOptions _options;
    Asio::ssl::context _ssl;
    Asio::io_context _context;
    std::shared_ptr<Request> _active;
};
}

Endpoint ParseEndpoint(std::string const& url)
{
    Endpoint endpoint;
    std::size_t start;
    if (url.starts_with("https://"))
    {
        endpoint.Tls = true;
        start = 8;
    }
    else if (url.starts_with("http://"))
        start = 7;
    else
        throw std::invalid_argument("endpoint must use HTTP or HTTPS");
    if (url.size() > 4096 || HasControlOrSpace(url) || url.find('#') != std::string::npos ||
        url.find('\\') != std::string::npos)
        throw std::invalid_argument("invalid endpoint");
    auto end = url.find_first_of("/?", start);
    endpoint.Authority = url.substr(start, end == std::string::npos ? end : end - start);
    if (endpoint.Authority.empty() || endpoint.Authority.find('@') != std::string::npos)
        throw std::invalid_argument("invalid endpoint authority");
    endpoint.Target = end == std::string::npos ? "/" : url.substr(end);
    if (endpoint.Target.front() == '?')
        endpoint.Target.insert(0, "/");
    auto authority = std::string_view(endpoint.Authority);
    std::string_view port;
    if (authority.front() == '[')
    {
        auto bracket = authority.find(']');
        if (bracket == std::string_view::npos)
            throw std::invalid_argument("invalid IPv6 endpoint");
        endpoint.Host = authority.substr(1, bracket - 1);
        Error error;
        Asio::ip::make_address_v6(endpoint.Host, error);
        if (error)
            throw std::invalid_argument("invalid IPv6 address");
        if (bracket + 1 < authority.size())
        {
            if (authority[bracket + 1] != ':')
                throw std::invalid_argument("invalid endpoint port");
            port = authority.substr(bracket + 2);
            if (port.empty())
                throw std::invalid_argument("empty endpoint port");
        }
    }
    else
    {
        auto colon = authority.find(':');
        endpoint.Host = authority.substr(0, colon);
        if (colon != std::string_view::npos)
        {
            port = authority.substr(colon + 1);
            if (port.empty())
                throw std::invalid_argument("empty endpoint port");
        }
    }
    if (endpoint.Host.empty())
        throw std::invalid_argument("empty endpoint host");
    if (!port.empty())
    {
        unsigned number = 0;
        auto result = std::from_chars(port.data(), port.data() + port.size(), number);
        if (result.ec != std::errc() || result.ptr != port.data() + port.size() || !number || number > 65535)
            throw std::invalid_argument("invalid endpoint port");
        endpoint.Port = port;
    }
    else
        endpoint.Port = endpoint.Tls ? "443" : "80";
    return endpoint;
}

std::chrono::seconds ParseRetryAfter(std::string const& value, std::chrono::system_clock::time_point now)
{
    if (value.empty() || value.size() > 128)
        return std::chrono::seconds(0);
    unsigned seconds = 0;
    auto result = std::from_chars(value.data(), value.data() + value.size(), seconds);
    if (result.ec == std::errc() && result.ptr == value.data() + value.size())
        return std::chrono::seconds(std::min(seconds, 60u));
    if (result.ec == std::errc::result_out_of_range &&
        value.find_first_not_of("0123456789") == std::string::npos)
        return std::chrono::seconds(60);
    std::tm utc{};
    std::istringstream stream(value);
    stream.imbue(std::locale::classic());
    stream >> std::get_time(&utc, "%a, %d %b %Y %H:%M:%S GMT");
    if (stream.fail() || stream.peek() != std::char_traits<char>::eof())
        return std::chrono::seconds(0);
#ifdef _WIN32
    auto date = _mkgmtime(&utc);
#else
    auto date = timegm(&utc);
#endif
    if (date < 0)
        return std::chrono::seconds(0);
    auto delay = std::chrono::ceil<std::chrono::seconds>(std::chrono::system_clock::from_time_t(date) - now);
    return std::clamp(delay, std::chrono::seconds(0), std::chrono::seconds(60));
}

std::unique_ptr<Transport> MakeHttpTransport(HttpOptions options)
{
    return std::make_unique<HttpTransport>(std::move(options));
}
}
