// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, spyOn, test } from "bun:test";
import { resolveObserver, validFollow } from "../src/web/follow.js";
import { validFollow as serverValidFollow } from "../src/watch.ts";

test("observer discovery pins its GUID and handles missing and ambiguous names", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
    characters: [{ guid: "observer-guid", name: "Observer" }],
  }));
  try {
    const guid = await resolveObserver("realm-1", null, "Observer", true);
    expect(guid).toBe("observer-guid");
    expect(String(fetcher.mock.calls[0]![0])).toBe("/api/characters?source=realm-1&character=Observer");
    fetcher.mockResolvedValue(Response.json({ characters: [] }));
    expect(await resolveObserver("realm-1", guid, "Oldname", true)).toBe(guid);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await resolveObserver("realm-1", null, "Fixed", false)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(resolveObserver("realm-1", null, "Missing", true)).rejects.toMatchObject({ status: 404 });
    fetcher.mockResolvedValue(Response.json({ characters: [{ guid: "one" }, { guid: "two" }] }));
    await expect(resolveObserver("realm-1", null, "Ambiguous", true)).rejects.toMatchObject({ status: 409 });
  } finally { fetcher.mockRestore(); }
});
test("browser and server agree on optional follow query validation", () => {
  for (const [query, expected] of [["", true], ["follow=watch", true], ["follow=", false],
    ["follow=bad", false], ["follow=watch&follow=watch", false]] as const) {
    expect(validFollow(new URLSearchParams(query))).toBe(expected);
    expect(serverValidFollow(new URLSearchParams(query))).toBe(expected);
  }
});
