// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef MOD_WIDGET_WATCH_H
#define MOD_WIDGET_WATCH_H

#include "CharacterCache.h"
#include "Player.h"
#if __has_include("../../mod-watch/src/WatchTarget.h")
#include "../../mod-watch/src/WatchTarget.h"
#endif

namespace WidgetWatch
{
// Called only by world-thread capture, never by packet hooks or delivery workers.
template <class Json>
Json Capture(Player const* player, bool offline = false)
{
#if __has_include("../../mod-watch/src/WatchTarget.h")
    if (!offline)
    {
        ObjectGuid guid = Watch::GetTarget(player->CustomData);
        std::string name;
        if (!guid.IsEmpty())
        {
            if (!sCharacterCache->GetCharacterNameByGuid(guid, name))
                name = "Unknown character";
            return {{"guid", guid.ToString()}, {"name", name}};
        }
    }
#else
    static_cast<void>(player);
    static_cast<void>(offline);
#endif
    return nullptr;
}
}

#endif
