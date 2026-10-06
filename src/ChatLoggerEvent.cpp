// SPDX-License-Identifier: GPL-2.0-or-later
#include "ChatLoggerEvent.h"
#include "Base64.h"
#include "Channel.h"
#include "ObjectGuid.h"
#include "Opcodes.h"
#include "SharedDefines.h"
#include "StringFormat.h"
#include <algorithm>
#include <ctime>
#include <stdexcept>

namespace ChatLogger
{
namespace
{
class Reader
{
public:
    explicit Reader(std::span<std::uint8_t const> bytes) : _bytes(bytes) { }

    template<typename T>
    T Read()
    {
        Require(sizeof(T));
        std::uint64_t value = 0;
        for (std::size_t i = 0; i < sizeof(T); ++i)
            value |= std::uint64_t(_bytes[_offset++]) << (8 * i);
        return static_cast<T>(value);
    }

    std::string String()
    {
        auto begin = _bytes.begin() + _offset;
        auto end = std::find(begin, _bytes.end(), 0);
        if (end == _bytes.end())
            throw std::runtime_error("unterminated string");
        std::string value(begin, end);
        _offset += value.size() + 1;
        return value;
    }

    std::string SizedString()
    {
        auto size = Read<std::uint32_t>();
        Require(size);
        if (!size)
            throw std::runtime_error("empty string extent");
        auto value = String();
        if (value.size() + 1 != size)
            throw std::runtime_error("invalid string extent");
        return value;
    }

    void Require(std::size_t size) const
    {
        if (size > Remaining())
            throw std::runtime_error("truncated packet");
    }

    std::size_t Remaining() const { return _bytes.size() - _offset; }

private:
    std::span<std::uint8_t const> _bytes;
    std::size_t _offset = 0;
};

Json Nullable(std::string const& value)
{
    return value.empty() ? Json(nullptr) : Json(value);
}

Json Guid(std::uint64_t value)
{
    return value ? Json(ObjectGuid(value).ToString()) : Json(nullptr);
}

Json Actor(std::uint64_t value, Json name = nullptr)
{
    return Json{{"guid", Guid(value)}, {"name", std::move(name)}};
}

char const* ChatType(std::uint32_t type)
{
    static constexpr char const* names[] =
    {
        "SYSTEM", "SAY", "PARTY", "RAID", "GUILD", "OFFICER", "YELL", "WHISPER",
        "WHISPER_FOREIGN", "WHISPER_INFORM", "EMOTE", "TEXT_EMOTE", "MONSTER_SAY", "MONSTER_PARTY",
        "MONSTER_YELL", "MONSTER_WHISPER", "MONSTER_EMOTE", "CHANNEL", "CHANNEL_JOIN", "CHANNEL_LEAVE",
        "CHANNEL_LIST", "CHANNEL_NOTICE", "CHANNEL_NOTICE_USER", "AFK", "DND", "IGNORED", "SKILL", "LOOT",
        "MONEY", "OPENING", "TRADESKILLS", "PET_INFO", "COMBAT_MISC_INFO", "COMBAT_XP_GAIN",
        "COMBAT_HONOR_GAIN", "COMBAT_FACTION_CHANGE", "BG_SYSTEM_NEUTRAL", "BG_SYSTEM_ALLIANCE",
        "BG_SYSTEM_HORDE", "RAID_LEADER", "RAID_WARNING", "RAID_BOSS_EMOTE", "RAID_BOSS_WHISPER",
        "FILTERED", "BATTLEGROUND", "BATTLEGROUND_LEADER", "RESTRICTED", "BATTLENET", "ACHIEVEMENT",
        "GUILD_ACHIEVEMENT", "ARENA_POINTS", "PARTY_LEADER"
    };
    static_assert(std::size(names) == MAX_CHAT_MSG_TYPE);
    return type < std::size(names) ? names[type] : "UNKNOWN";
}

char const* OpcodeName(std::uint16_t opcode)
{
#define CHAT_LOGGER_OPCODE(name) case name: return #name
    switch (opcode)
    {
        CHAT_LOGGER_OPCODE(CMSG_MESSAGECHAT);
        CHAT_LOGGER_OPCODE(CMSG_TEXT_EMOTE);
        CHAT_LOGGER_OPCODE(SMSG_MESSAGECHAT);
        CHAT_LOGGER_OPCODE(SMSG_GM_MESSAGECHAT);
        CHAT_LOGGER_OPCODE(SMSG_TEXT_EMOTE);
        CHAT_LOGGER_OPCODE(SMSG_CHANNEL_NOTIFY);
        CHAT_LOGGER_OPCODE(SMSG_CHANNEL_LIST);
        CHAT_LOGGER_OPCODE(SMSG_CHANNEL_MEMBER_COUNT);
        CHAT_LOGGER_OPCODE(SMSG_NOTIFICATION);
        CHAT_LOGGER_OPCODE(SMSG_MOTD);
        CHAT_LOGGER_OPCODE(SMSG_CHAT_SERVER_MESSAGE);
        CHAT_LOGGER_OPCODE(SMSG_ZONE_UNDER_ATTACK);
        CHAT_LOGGER_OPCODE(SMSG_DEFENSE_MESSAGE);
        CHAT_LOGGER_OPCODE(SMSG_CHAT_PLAYER_NOT_FOUND);
        CHAT_LOGGER_OPCODE(SMSG_CHAT_PLAYER_AMBIGUOUS);
        CHAT_LOGGER_OPCODE(SMSG_CHAT_WRONG_FACTION);
        CHAT_LOGGER_OPCODE(SMSG_CHAT_RESTRICTED);
        CHAT_LOGGER_OPCODE(SMSG_CHAT_NOT_IN_PARTY);
        default: return "UNKNOWN";
    }
#undef CHAT_LOGGER_OPCODE
}

Json Envelope(CapturedPacket const& packet, std::string const& processId)
{
    bool incoming = packet.Flow == Direction::Incoming;
    return
    {
        {"event_id", Acore::StringFormat("{}:{}", processId, packet.Sequence)},
        {"captured_at", FormatTimestamp(packet.CapturedAt)},
        {"direction", incoming ? "incoming" : "outgoing"},
        {"observation", incoming ? "client_submission" : "send_attempt"},
        {"opcode", OpcodeName(packet.Opcode)}, {"opcode_id", packet.Opcode},
        {"event_kind", "notice"},
        {"session", {{"account_id", packet.Session.AccountId},
            {"character_guid", Nullable(packet.Session.CharacterGuid)},
            {"character_name", Nullable(packet.Session.CharacterName)}, {"locale", packet.Session.Locale},
            {"login_id", Nullable(packet.Session.LoginId)}, {"started_at", Nullable(packet.Session.StartedAt)}}},
        {"sender", incoming ? Json{{"guid", Nullable(packet.Session.CharacterGuid)},
            {"name", Nullable(packet.Session.CharacterName)}} : Json(nullptr)},
        {"target", nullptr}, {"channel", nullptr}, {"text", nullptr},
        {"chat_type", nullptr}, {"chat_type_id", nullptr}, {"language", nullptr},
        {"notice", nullptr}, {"emote", nullptr}, {"decoding_status", "ok"}, {"raw_packet_base64", nullptr}
    };
}

bool IncomingChat(Reader& reader, Json& event)
{
    auto type = reader.Read<std::uint32_t>();
    event["event_kind"] = "chat";
    event["chat_type_id"] = type;
    event["chat_type"] = ChatType(type);
    event["language"] = reader.Read<std::uint32_t>();
    switch (type)
    {
        case CHAT_MSG_WHISPER:
            event["target"] = {{"guid", nullptr}, {"name", reader.String()}};
            break;
        case CHAT_MSG_CHANNEL:
            event["channel"] = reader.String();
            break;
        case CHAT_MSG_SAY:
        case CHAT_MSG_YELL:
        case CHAT_MSG_EMOTE:
        case CHAT_MSG_PARTY:
        case CHAT_MSG_PARTY_LEADER:
        case CHAT_MSG_RAID:
        case CHAT_MSG_RAID_LEADER:
        case CHAT_MSG_RAID_WARNING:
        case CHAT_MSG_GUILD:
        case CHAT_MSG_OFFICER:
        case CHAT_MSG_BATTLEGROUND:
        case CHAT_MSG_BATTLEGROUND_LEADER:
        case CHAT_MSG_AFK:
        case CHAT_MSG_DND:
            break;
        default:
            return false;
    }
    event["text"] = reader.String();
    return true;
}

bool OutgoingChat(Reader& reader, Json& event, bool gm)
{
    auto type = reader.Read<std::uint8_t>();
    event["event_kind"] = "chat";
    event["chat_type_id"] = type;
    event["chat_type"] = ChatType(type);
    event["language"] = reader.Read<std::uint32_t>();
    auto sender = reader.Read<std::uint64_t>();
    event["sender"] = Actor(sender);
    event["chat_flags"] = reader.Read<std::uint32_t>();
    std::uint64_t target = 0;
    switch (type)
    {
        case CHAT_MSG_MONSTER_SAY:
        case CHAT_MSG_MONSTER_PARTY:
        case CHAT_MSG_MONSTER_YELL:
        case CHAT_MSG_MONSTER_WHISPER:
        case CHAT_MSG_MONSTER_EMOTE:
        case CHAT_MSG_RAID_BOSS_EMOTE:
        case CHAT_MSG_RAID_BOSS_WHISPER:
        case CHAT_MSG_BATTLENET:
            event["sender"]["name"] = reader.SizedString();
            target = reader.Read<std::uint64_t>();
            event["target"] = Actor(target);
            if (target && !ObjectGuid(target).IsPlayer() && !ObjectGuid(target).IsPet())
                event["target"]["name"] = reader.SizedString();
            break;
        case CHAT_MSG_WHISPER_FOREIGN:
            event["sender"]["name"] = reader.SizedString();
            event["target"] = Actor(reader.Read<std::uint64_t>());
            break;
        case CHAT_MSG_BG_SYSTEM_NEUTRAL:
        case CHAT_MSG_BG_SYSTEM_ALLIANCE:
        case CHAT_MSG_BG_SYSTEM_HORDE:
            target = reader.Read<std::uint64_t>();
            event["target"] = Actor(target);
            if (target && !ObjectGuid(target).IsPlayer())
                event["target"]["name"] = reader.SizedString();
            break;
        case CHAT_MSG_ACHIEVEMENT:
        case CHAT_MSG_GUILD_ACHIEVEMENT:
            event["target"] = Actor(reader.Read<std::uint64_t>());
            break;
        default:
            if (type >= MAX_CHAT_MSG_TYPE)
                return false;
            if (gm)
                event["sender"]["name"] = reader.SizedString();
            if (type == CHAT_MSG_CHANNEL)
                event["channel"] = reader.String();
            event["target"] = Actor(reader.Read<std::uint64_t>());
            break;
    }
    event["text"] = reader.SizedString();
    event["chat_tag"] = reader.Read<std::uint8_t>();
    if (type == CHAT_MSG_ACHIEVEMENT || type == CHAT_MSG_GUILD_ACHIEVEMENT)
        event["achievement_id"] = reader.Read<std::uint32_t>();
    return true;
}

bool ChannelNotice(Reader& reader, Json& event)
{
    auto type = reader.Read<std::uint8_t>();
    event["channel"] = reader.String();
    Json notice = {{"id", type}};
    switch (type)
    {
        case CHAT_JOINED_NOTICE:
        case CHAT_LEFT_NOTICE:
        case CHAT_PASSWORD_CHANGED_NOTICE:
        case CHAT_OWNER_CHANGED_NOTICE:
        case CHAT_ANNOUNCEMENTS_ON_NOTICE:
        case CHAT_ANNOUNCEMENTS_OFF_NOTICE:
        case CHAT_MODERATION_ON_NOTICE:
        case CHAT_MODERATION_OFF_NOTICE:
        case CHAT_PLAYER_ALREADY_MEMBER_NOTICE:
        case CHAT_INVITE_NOTICE:
        case CHAT_VOICE_ON_NOTICE:
        case CHAT_VOICE_OFF_NOTICE:
            notice["actor_guid"] = Guid(reader.Read<std::uint64_t>());
            break;
        case CHAT_PLAYER_KICKED_NOTICE:
        case CHAT_PLAYER_BANNED_NOTICE:
        case CHAT_PLAYER_UNBANNED_NOTICE:
            notice["target_guid"] = Guid(reader.Read<std::uint64_t>());
            notice["actor_guid"] = Guid(reader.Read<std::uint64_t>());
            break;
        case CHAT_PLAYER_NOT_FOUND_NOTICE:
        case CHAT_CHANNEL_OWNER_NOTICE:
        case CHAT_PLAYER_NOT_BANNED_NOTICE:
        case CHAT_PLAYER_INVITED_NOTICE:
        case CHAT_PLAYER_INVITE_BANNED_NOTICE:
            notice["name"] = reader.String();
            break;
        case CHAT_YOU_JOINED_NOTICE:
            notice["flags"] = reader.Read<std::uint8_t>();
            notice["channel_id"] = reader.Read<std::uint32_t>();
            notice["instance_id"] = reader.Read<std::uint32_t>();
            break;
        case CHAT_YOU_LEFT_NOTICE:
            notice["channel_id"] = reader.Read<std::uint32_t>();
            notice["constant"] = reader.Read<std::uint8_t>();
            break;
        case CHAT_MODE_CHANGE_NOTICE:
            notice["actor_guid"] = Guid(reader.Read<std::uint64_t>());
            notice["old_flags"] = reader.Read<std::uint8_t>();
            notice["new_flags"] = reader.Read<std::uint8_t>();
            break;
        default:
            if (type > CHAT_VOICE_OFF_NOTICE)
                return false;
            break;
    }
    event["notice"] = std::move(notice);
    return true;
}

bool DecodeBody(CapturedPacket const& packet, Reader& reader, Json& event)
{
    switch (packet.Opcode)
    {
        case CMSG_MESSAGECHAT:
            return IncomingChat(reader, event);
        case SMSG_MESSAGECHAT:
        case SMSG_GM_MESSAGECHAT:
            return OutgoingChat(reader, event, packet.Opcode == SMSG_GM_MESSAGECHAT);
        case CMSG_TEXT_EMOTE:
        case SMSG_TEXT_EMOTE:
        {
            event["event_kind"] = "text_emote";
            if (packet.Flow == Direction::Outgoing)
                event["sender"] = Actor(reader.Read<std::uint64_t>());
            event["emote"] = {{"id", reader.Read<std::uint32_t>()},
                {"variation", reader.Read<std::uint32_t>()}};
            if (packet.Flow == Direction::Incoming)
                event["target"] = Actor(reader.Read<std::uint64_t>());
            else
            {
                auto length = reader.Read<std::uint32_t>();
                auto name = reader.String();
                if (name.size() != (length > 1 ? length : 0))
                    throw std::runtime_error("invalid emote name extent");
                event["target"] = {{"guid", nullptr}, {"name", Nullable(name)}};
            }
            return true;
        }
        case SMSG_CHANNEL_NOTIFY:
            return ChannelNotice(reader, event);
        case SMSG_CHANNEL_LIST:
        {
            event["notice"] = {{"type", reader.Read<std::uint8_t>()}};
            event["channel"] = reader.String();
            event["notice"]["flags"] = reader.Read<std::uint8_t>();
            auto count = reader.Read<std::uint32_t>();
            if (count > reader.Remaining() / 9)
                throw std::runtime_error("invalid member count");
            auto members = Json::array();
            for (std::uint32_t i = 0; i < count; ++i)
                members.push_back({{"guid", Guid(reader.Read<std::uint64_t>())},
                    {"flags", reader.Read<std::uint8_t>()}});
            event["notice"]["members"] = std::move(members);
            return true;
        }
        case SMSG_CHANNEL_MEMBER_COUNT:
            event["channel"] = reader.String();
            event["notice"] = {{"flags", reader.Read<std::uint8_t>()},
                {"member_count", reader.Read<std::uint32_t>()}};
            return true;
        case SMSG_NOTIFICATION:
            event["text"] = reader.String();
            return true;
        case SMSG_CHAT_PLAYER_NOT_FOUND:
        case SMSG_CHAT_PLAYER_AMBIGUOUS:
            event["target"] = {{"guid", nullptr}, {"name", reader.String()}};
            return true;
        case SMSG_CHAT_WRONG_FACTION:
            return true;
        case SMSG_CHAT_RESTRICTED:
            event["notice"] = {{"id", reader.Read<std::uint8_t>()}};
            return true;
        case SMSG_CHAT_NOT_IN_PARTY:
        case SMSG_ZONE_UNDER_ATTACK:
            event["notice"] = {{"id", reader.Read<std::uint32_t>()}};
            return true;
        case SMSG_CHAT_SERVER_MESSAGE:
            event["notice"] = {{"id", reader.Read<std::uint32_t>()}};
            event["text"] = reader.String();
            return true;
        case SMSG_MOTD:
        {
            auto count = reader.Read<std::uint32_t>();
            if (count > reader.Remaining())
                throw std::runtime_error("invalid line count");
            auto lines = Json::array();
            for (std::uint32_t i = 0; i < count; ++i)
                lines.push_back(reader.String());
            event["notice"] = {{"lines", std::move(lines)}};
            return true;
        }
        default:
            // No producer in this core establishes the layout of SMSG_DEFENSE_MESSAGE.
            return false;
    }
}
}

std::size_t CapturedPacket::MemorySize() const
{
    // Include allocation/container overhead and retain this charge while a batch is in flight.
    return sizeof(CapturedPacket) + 128 + Bytes.capacity() + Session.CharacterGuid.capacity() +
        Session.CharacterName.capacity() + Session.Locale.capacity() + Session.LoginId.capacity() +
        Session.StartedAt.capacity() + Presence.capacity();
}

bool IsSelectedPacket(Direction direction, std::uint16_t opcode)
{
    if (direction == Direction::Incoming)
        return opcode == CMSG_MESSAGECHAT || opcode == CMSG_TEXT_EMOTE;
    return opcode != CMSG_MESSAGECHAT && opcode != CMSG_TEXT_EMOTE &&
        std::string_view(OpcodeName(opcode)) != "UNKNOWN";
}

bool IsAddonPacket(std::uint16_t opcode, std::span<std::uint8_t const> bytes)
{
    std::size_t offset;
    if (opcode == CMSG_MESSAGECHAT)
        offset = sizeof(std::uint32_t);
    else if (opcode == SMSG_MESSAGECHAT || opcode == SMSG_GM_MESSAGECHAT)
        offset = sizeof(std::uint8_t);
    else
        return false;
    if (bytes.size() < offset + sizeof(std::uint32_t))
        return false;
    Reader reader(bytes.subspan(offset));
    return reader.Read<std::uint32_t>() == LANG_ADDON;
}

std::string FormatTimestamp(std::chrono::system_clock::time_point time)
{
    auto seconds = std::chrono::floor<std::chrono::seconds>(time);
    auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(time - seconds).count();
    auto value = std::chrono::system_clock::to_time_t(seconds);
    std::tm utc{};
#ifdef _WIN32
    gmtime_s(&utc, &value);
#else
    gmtime_r(&value, &utc);
#endif
    return Acore::StringFormat("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", utc.tm_year + 1900,
        utc.tm_mon + 1, utc.tm_mday, utc.tm_hour, utc.tm_min, utc.tm_sec, milliseconds);
}

Json Decode(CapturedPacket const& packet, std::string const& processId)
{
    Json event = Envelope(packet, processId);
    if (!packet.Presence.empty())
    {
        event["event_kind"] = "presence";
        event["observation"] = "character_presence";
        event["opcode"] = nullptr;
        event["opcode_id"] = nullptr;
        event["presence"] = packet.Presence;
        event["sequence"] = std::to_string(packet.Sequence);
        return event;
    }
    Reader reader(packet.Bytes);
    try
    {
        bool supported = DecodeBody(packet, reader, event);
        if (!supported || reader.Remaining())
        {
            event["decoding_status"] = supported ? "trailing_bytes" : "unsupported";
            event["raw_packet_base64"] = Acore::Encoding::Base64::Encode(packet.Bytes);
        }
        // Validate UTF-8 before constructing a batch; never let a bad string poison other events.
        static_cast<void>(event.dump());
    }
    catch (std::exception const&)
    {
        event = Envelope(packet, processId);
        event["decoding_status"] = "malformed";
        event["raw_packet_base64"] = Acore::Encoding::Base64::Encode(packet.Bytes);
    }
    return event;
}
}
