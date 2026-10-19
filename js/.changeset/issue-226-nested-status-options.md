---
'start-command': patch
---

`$ --status` no longer prints `[object Object]` for nested option values such as `launchOwner`, `exitEvidence`, `resolvedLimits` and `resourceLimitSpecs`: the links-notation output nests them like other objects and the text output prints them as compact JSON (#226).
