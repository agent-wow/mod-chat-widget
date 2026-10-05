// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef MOD_CHAT_LOGGER_EVENT_H
#define MOD_CHAT_LOGGER_EVENT_H

#include "../vendor/nlohmann/json.hpp"
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace ChatLogger
{
using Json = nlohmann::json;
using SteadyTime = std::chrono::steady_clock::time_point;

enum class Direction : std::uint8_t
{
    Incoming,
    Outgoing
};

struct SessionInfo
{
    std::uint32_t AccountId = 0;
    std::string CharacterGuid;
    std::string CharacterName;
    std::string Locale;
};

struct CapturedPacket
{
    Direction Flow = Direction::Incoming;
    std::uint16_t Opcode = 0;
    SessionInfo Session;
    std::vector<std::uint8_t> Bytes;
    std::chrono::system_clock::time_point CapturedAt;
    std::uint64_t Sequence = 0;

    std::size_t MemorySize() const;
};

bool IsSelectedPacket(Direction direction, std::uint16_t opcode);
bool IsAddonPacket(std::uint16_t opcode, std::span<std::uint8_t const> bytes);
Json Decode(CapturedPacket const& packet, std::string const& processId);
std::string FormatTimestamp(std::chrono::system_clock::time_point time);
}

#endif
