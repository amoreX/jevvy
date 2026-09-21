# Test protection for Jev

These optional commands target vanilla Java 26.2. A server administrator must
apply them; the client cannot grant itself operator permissions.

With Jev online, run each line of `test-protection-on.txt` in the server console,
in order. An operator can instead run them in Minecraft chat with `/` before
each line. Apply the protective effects before returning Jev to survival.

Resistance V blocks ordinary damage, including mob attacks. Fire Resistance,
Water Breathing, Saturation and Regeneration cover common testing hazards while
preserving survival interactions. This affects only Jev, not world difficulty or
other players. Milk, death, or clearing effects removes protection; reapply these
commands if that happens. Infinite durations do not need periodic renewal.
This does not protect against the void or an operator's `/kill` command.

After application, check Jev's server-reported `gameMode` and `effects` in
`runtime/status.json` or `/api/status`. Resistance is effect ID 10 in the installed
26.2 registry and must have amplifier 4. Only then resume tasks in the viewer or
with `@jev resume` in game. The server must also allow mining at Jev's position;
survival mode and damage protection do not bypass spawn protection. If protected
blocks enclose him, relocate him to clear ground outside that protected area.

Run `test-protection-off.txt` to remove these five effects when testing is over.
This also removes any matching effects acquired during normal gameplay.

## Keep Jev in survival

The local client requests `/gamemode survival` on login or a mode change when
the server advertises permission to use `gamemode`. It waits for a server mode
packet to confirm success. `survivalMode` in `/api/status` distinguishes confirmed
survival from `needs_server_permission` or `awaiting_server`. The client cannot
grant itself permissions or force a server to accept a mode change.

An administrator can immediately set Jev's mode with `gamemode survival Jev` in
the console. Apply the test-protection effects above first while testing. For
server-side enforcement without granting Jev operator permissions, an admin can
run this in an always-active repeating command block in a loaded chunk (with
command blocks enabled), or a datapack's tick function:

```mcfunction
execute as @a[name=Jev,gamemode=!survival] run gamemode survival @s
```

This only changes Jev's mode. It does not make survival invulnerable.
