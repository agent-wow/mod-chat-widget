// SPDX-License-Identifier: GPL-2.0-or-later
#include "ChatLoggerRunner.h"
#include "Config.h"
#include "CryptoRandom.h"
#include "Log.h"
#include "Player.h"
#include "PlayerScript.h"
#include "ServerScript.h"
#include "StringFormat.h"
#include "WorldPacket.h"
#include "WorldScript.h"
#include "WorldSession.h"
#include "WorldSessionMgr.h"
#include <boost/uuid/uuid.hpp>
#include <boost/uuid/uuid_io.hpp>
#include <algorithm>
#include <condition_variable>
#include <stdexcept>
#include <thread>
#include <unordered_map>

namespace ChatLogger
{
namespace
{
struct Settings
{
    bool Incoming = true;
    bool Outgoing = true;
    Limits Bounds;
    HttpOptions Http;
    std::string SourceId;
};

Settings ReadSettings(std::string const& endpoint)
{
    Settings settings;
    settings.Incoming = sConfigMgr->GetOption<bool>("ChatLogger.CaptureIncoming", true);
    settings.Outgoing = sConfigMgr->GetOption<bool>("ChatLogger.CaptureOutgoing", true);
    settings.SourceId = sConfigMgr->GetOption<std::string>("ChatLogger.SourceId",
        Acore::StringFormat("realm-{}", sConfigMgr->GetOption<uint32>("RealmID", 1)));
    if (settings.SourceId.empty() || settings.SourceId.size() > 256)
        throw std::invalid_argument("invalid source id");
    static_cast<void>(Json(settings.SourceId).dump());
    auto& limits = settings.Bounds;
    limits.QueueEvents = sConfigMgr->GetOption<uint32>("ChatLogger.QueueEvents", 10000);
    limits.QueueBytes = sConfigMgr->GetOption<uint32>("ChatLogger.QueueBytes", 16 * 1024 * 1024);
    limits.BatchEvents = sConfigMgr->GetOption<uint32>("ChatLogger.BatchEvents", 100);
    limits.BatchBytes = sConfigMgr->GetOption<uint32>("ChatLogger.BatchBytes", 512 * 1024);
    limits.PacketBytes = sConfigMgr->GetOption<uint32>("ChatLogger.PacketBytes", 64 * 1024);
    limits.FlushInterval = std::chrono::milliseconds(sConfigMgr->GetOption<uint32>("ChatLogger.FlushMs", 100));
    if (limits.QueueEvents > 1000000 || limits.BatchEvents > limits.QueueEvents ||
        limits.PacketBytes > 64 * 1024 || limits.BatchBytes > 8 * 1024 * 1024 ||
        limits.QueueBytes > 1024 * 1024 * 1024 || limits.FlushInterval > std::chrono::seconds(60))
        throw std::invalid_argument("queue limits out of range");
    settings.Http.Destination = ParseEndpoint(endpoint);
    settings.Http.BearerToken = sConfigMgr->GetOption<std::string>("ChatLogger.BearerToken", "");
    settings.Http.CaFile = sConfigMgr->GetOption<std::string>("ChatLogger.CAFile", "");
    settings.Http.ConnectTimeout = std::chrono::milliseconds(
        sConfigMgr->GetOption<uint32>("ChatLogger.ConnectTimeoutMs", 3000));
    settings.Http.RequestTimeout = std::chrono::milliseconds(
        sConfigMgr->GetOption<uint32>("ChatLogger.RequestTimeoutMs", 5000));
    return settings;
}

std::string ProcessId()
{
    auto bytes = Acore::Crypto::GetRandomBytes<16>();
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
    boost::uuids::uuid id;
    std::copy(bytes.begin(), bytes.end(), id.begin());
    return boost::uuids::to_string(id);
}

class Runtime
{
public:
    explicit Runtime(Settings settings) : _settings(std::move(settings)), _queue(_settings.Bounds, _counters),
        _delivery(_queue, _counters, _settings.Bounds, _settings.SourceId, ProcessId()),
        _transport(MakeHttpTransport(_settings.Http)),
        _runner(_queue, _delivery, *_transport, [] { return std::chrono::steady_clock::now(); }) { }

    ~Runtime() { Stop(); }

    void Start()
    {
        _worker = std::thread([this] { Run(); });
    }

    void Stop()
    {
        std::lock_guard lock(_lifecycleMutex);
        if (!_worker.joinable())
            return;
        _runner.BeginShutdown();
        _wake.notify_one();
        _worker.join();
    }

    bool Wants(Direction direction) const
    {
        return _running.load() && (direction == Direction::Incoming ? _settings.Incoming : _settings.Outgoing);
    }

    void Capture(Direction direction, WorldPacket const& packet, SessionInfo session)
    {
        if (packet.size() > _settings.Bounds.PacketBytes)
        {
            ++_counters.Oversized[Index(direction)];
            return;
        }
        CapturedPacket captured;
        captured.Flow = direction;
        captured.Opcode = packet.GetOpcode();
        captured.CapturedAt = std::chrono::system_clock::now();
        captured.Session = std::move(session);
        if (!packet.empty())
            captured.Bytes.assign(packet.contents(), packet.contents() + packet.size());
        if (_queue.Push(std::move(captured)))
            _wake.notify_one();
    }

    void CaptureFailed() { ++_counters.CaptureFailures; }

    void Presence(SessionInfo const& session, char const* presence)
    {
        CapturedPacket captured;
        captured.Flow = Direction::Outgoing;
        captured.CapturedAt = std::chrono::system_clock::now();
        captured.Session = session;
        captured.Presence = presence;
        if (_queue.Push(std::move(captured)))
            _wake.notify_one();
    }

private:
    void Report()
    {
        auto size = _queue.Size();
        LOG_INFO("module.chatlogger", "Queue events={} accounted_bytes={} retries={} decode_failures={} "
            "capture_failures={}", size.first, size.second, _counters.Retries.load(),
            _counters.DecodeFailures.load(), _counters.CaptureFailures.load());
        for (auto direction : {Direction::Incoming, Direction::Outgoing})
        {
            auto index = Index(direction);
            LOG_INFO("module.chatlogger", "{} captured={} sent={} overflow={} oversized={} "
                "rejected={} shutdown_dropped={}",
                direction == Direction::Incoming ? "incoming" : "outgoing", _counters.Captured[index].load(),
                _counters.Sent[index].load(), _counters.Overflow[index].load(), _counters.Oversized[index].load(),
                _counters.Rejected[index].load(), _counters.ShutdownDropped[index].load());
        }
    }

    void Run()
    {
        auto nextReport = std::chrono::steady_clock::now() + std::chrono::seconds(60);
        auto nextError = std::chrono::steady_clock::time_point::min();
        try
        {
            while (_runner.Tick())
            {
                auto now = std::chrono::steady_clock::now();
                if (auto response = _runner.LastResponse(); response &&
                    ClassifyResponse(response->Status) != ResponseAction::Acknowledge && now >= nextError)
                {
                    LOG_WARN("module.chatlogger", "Delivery failed: HTTP status {} "
                        "(0 means transport failure), action={}", response->Status,
                        ClassifyResponse(response->Status) == ResponseAction::Retry ? "retry" : "drop");
                    nextError = now + std::chrono::seconds(30);
                }
                if (now >= nextReport)
                {
                    Report();
                    nextReport = now + std::chrono::seconds(60);
                }
                std::unique_lock lock(_waitMutex);
                _wake.wait_for(lock, std::chrono::milliseconds(50));
            }
        }
        catch (std::exception const&)
        {
            _runner.Abort();
            LOG_ERROR("module.chatlogger", "Delivery worker stopped after an internal error; "
                "remaining events discarded");
        }
        _running.store(false);
        Report();
    }

    Settings _settings;
    Counters _counters;
    CaptureQueue _queue;
    Delivery _delivery;
    std::unique_ptr<Transport> _transport;
    Runner _runner;
    std::atomic<bool> _running{true};
    std::mutex _lifecycleMutex;
    std::mutex _waitMutex;
    std::condition_variable _wake;
    std::thread _worker;
};

class Service
{
public:
    void Start()
    {
        if (!sConfigMgr->GetOption<bool>("ChatLogger.Enable", true))
            return;
        try
        {
            auto endpoint = sConfigMgr->GetOption<std::string>("ChatLogger.Endpoint", "");
            if (endpoint.find_first_not_of(" \t\r\n") == std::string::npos)
            {
                LOG_INFO("module.chatlogger", "Chat logger inactive: no endpoint configured");
                return;
            }
            auto runtime = std::make_shared<Runtime>(ReadSettings(endpoint));
            runtime->Start();
            _runtime.store(std::move(runtime));
            LOG_INFO("module.chatlogger", "Chat logger started; configuration changes require a restart");
        }
        catch (std::exception const&)
        {
            // Exception strings from HTTP/configuration libraries may include credentials or URL details.
            LOG_ERROR("module.chatlogger", "Chat logger disabled: invalid configuration or startup failure");
        }
    }

    void Stop()
    {
        if (auto runtime = _runtime.exchange(nullptr))
        {
            {
                std::lock_guard lock(_identityMutex);
                for (auto const& [account, info] : _identities)
                {
                    static_cast<void>(account);
                    try
                    {
                        runtime->Presence(info, "offline");
                    }
                    catch (...)
                    {
                        runtime->CaptureFailed();
                    }
                }
                _identities.clear();
            }
            runtime->Stop();
        }
    }

    void Login(Player* player) noexcept
    {
        auto runtime = _runtime.load();
        if (!runtime)
            return;
        try
        {
            auto session = player->GetSession();
            if (!session || session->IsHeadless())
                return;
            SessionInfo info;
            info.AccountId = session->GetAccountId();
            info.CharacterGuid = player->GetGUID().ToString();
            info.CharacterName = player->GetName();
            info.Locale = localeNames[session->GetSessionDbcLocale()];
            std::lock_guard lock(_identityMutex);
            if (auto itr = _identities.find(info.AccountId); itr != _identities.end() &&
                itr->second.CharacterGuid == info.CharacterGuid)
            {
                info.LoginId = itr->second.LoginId;
                info.StartedAt = itr->second.StartedAt;
            }
            else
            {
                info.LoginId = ProcessId();
                info.StartedAt = FormatTimestamp(std::chrono::system_clock::now());
            }
            runtime->Presence(info, "online");
            _identities[info.AccountId] = std::move(info);
        }
        catch (...)
        {
            runtime->CaptureFailed();
        }
    }

    void Logout(Player* player) noexcept
    {
        auto runtime = _runtime.load();
        if (!runtime)
            return;
        try
        {
            std::lock_guard lock(_identityMutex);
            auto itr = _identities.find(player->GetSession()->GetAccountId());
            if (itr == _identities.end())
                return;
            auto info = std::move(itr->second);
            _identities.erase(itr);
            runtime->Presence(info, "offline");
        }
        catch (...)
        {
            runtime->CaptureFailed();
        }
    }

    void Update(uint32 diff) noexcept
    {
        auto runtime = _runtime.load();
        if (!runtime)
            return;
        _elapsed += diff;
        if (_elapsed < 5000)
            return;
        _elapsed %= 5000;
        try
        {
            // This world hook runs after the map workers join; player access is safe for this tick.
            std::lock_guard lock(_identityMutex);
            for (auto const& [account, session] : sWorldSessionMgr->GetAllSessions())
                if (auto player = session->GetPlayer(); player && !session->PlayerLogout())
                    if (auto itr = _identities.find(account); itr != _identities.end())
                        runtime->Presence(itr->second,
                            player->IsInWorld() && !player->IsBeingTeleported() ? "online" : "unavailable");
        }
        catch (...)
        {
            runtime->CaptureFailed();
        }
    }

    void Capture(WorldSession* session, WorldPacket const& packet, Direction direction) noexcept
    {
        auto runtime = _runtime.load();
        if (!runtime || !session || session->IsHeadless() || !runtime->Wants(direction) ||
            !IsSelectedPacket(direction, packet.GetOpcode()))
            return;
        try
        {
            std::span<uint8 const> bytes;
            if (!packet.empty())
                bytes = {packet.contents(), packet.size()};
            if (IsAddonPacket(packet.GetOpcode(), bytes))
                return;
            SessionInfo info;
            info.AccountId = session->GetAccountId();
            info.Locale = localeNames[session->GetSessionDbcLocale()];
            {
                std::lock_guard lock(_identityMutex);
                if (auto itr = _identities.find(info.AccountId); itr != _identities.end())
                    info = itr->second;
            }
            // Logged-in incoming handlers own the player for this call. Outgoing callbacks may run
            // on other threads, so they use lifecycle snapshots rather than dereferencing Player.
            if (direction == Direction::Incoming)
                if (auto player = session->GetPlayer())
                {
                    info.CharacterGuid = player->GetGUID().ToString();
                    info.CharacterName = player->GetName();
                }
            runtime->Capture(direction, packet, std::move(info));
        }
        catch (...)
        {
            runtime->CaptureFailed();
        }
    }

private:
    std::atomic<std::shared_ptr<Runtime>> _runtime;
    std::mutex _identityMutex;
    std::unordered_map<uint32, SessionInfo> _identities;
    uint32 _elapsed = 0;
};

class ChatLoggerServer final : public ServerScript
{
public:
    explicit ChatLoggerServer(std::shared_ptr<Service> service) :
        ServerScript("ChatLoggerServer", {SERVERHOOK_CAN_PACKET_RECEIVE, SERVERHOOK_ON_PACKET_SENT}),
        _service(std::move(service)) { }

    bool CanPacketReceive(WorldSession* session, WorldPacket const& packet) override
    {
        _service->Capture(session, packet, Direction::Incoming);
        return true;
    }

    void OnPacketSent(WorldSession* session, WorldPacket const& packet) override
    {
        _service->Capture(session, packet, Direction::Outgoing);
    }

private:
    std::shared_ptr<Service> _service;
};

class ChatLoggerWorld final : public WorldScript
{
public:
    explicit ChatLoggerWorld(std::shared_ptr<Service> service) :
        WorldScript("ChatLoggerWorld", {WORLDHOOK_ON_STARTUP, WORLDHOOK_ON_UPDATE,
            WORLDHOOK_ON_SHUTDOWN, WORLDHOOK_ON_AFTER_CONFIG_LOAD}),
        _service(std::move(service)) { }

    ~ChatLoggerWorld() override { _service->Stop(); }
    void OnStartup() override { _service->Start(); }
    void OnUpdate(uint32 diff) override { _service->Update(diff); }
    void OnShutdown() override { _service->Stop(); }
    void OnAfterConfigLoad(bool reload) override
    {
        if (reload)
            LOG_INFO("module.chatlogger", "Chat logger settings are startup-only; restart to apply changes");
    }

private:
    std::shared_ptr<Service> _service;
};

class ChatLoggerPlayer final : public PlayerScript
{
public:
    explicit ChatLoggerPlayer(std::shared_ptr<Service> service) :
        PlayerScript("ChatLoggerPlayer", {PLAYERHOOK_ON_LOAD_FROM_DB, PLAYERHOOK_ON_LOGIN,
            PLAYERHOOK_ON_BEFORE_LOGOUT}),
        _service(std::move(service)) { }

    // MOTD and other login packets are sent before OnPlayerLogin. LoadFromDB already has the verified
    // character identity here, after its failure checks and before the session sends those packets.
    void OnPlayerLoadFromDB(Player* player) override { _service->Login(player); }
    void OnPlayerLogin(Player* player) override { _service->Login(player); }
    void OnPlayerBeforeLogout(Player* player) override { _service->Logout(player); }

private:
    std::shared_ptr<Service> _service;
};
}
}

void Addmod_chat_widgetScripts()
{
    auto service = std::make_shared<ChatLogger::Service>();
    new ChatLogger::ChatLoggerServer(service);
    new ChatLogger::ChatLoggerWorld(service);
    new ChatLogger::ChatLoggerPlayer(service);
}
