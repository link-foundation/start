# Timeline

## 2026-06-24 13:48:22Z

The issue log shows a detached Docker isolation command was started. The
execution record had UUID `30b64fa6-0395-4271-8a07-80555eb392e4`, session name
`4d28fe9b-bc0e-467d-9fae-d1d15579b410`, and container ID
`03d0fe80eb570631808c6682556820c6e2d93c4dcfb0142d6105120c4eafa228`.

## 2026-06-24 16:17:57Z

`$ --status 4d28fe9b-bc0e-467d-9fae-d1d15579b410` reported the execution as
`executing`, with Docker container metadata present.

## 2026-06-24 16:18:00Z

`$ --stop 4d28fe9b-bc0e-467d-9fae-d1d15579b410` reported
`status signal-sent`, `backend docker`, and `method SIGINT`.

## 2026-06-24 16:18:09Z

A follow-up status query still reported `status executing`, proving the stop
request did not stop the detached container.

## 2026-06-24 16:21:58Z

Issue #142 was opened with the failing transcript and the manual workaround:
`docker stop 03d0fe80eb570631808c6682556820c6e2d93c4dcfb0142d6105120c4eafa228`.

## Investigation

The JS and Rust execution-control helpers both mapped Docker stop to
`docker kill --signal=SIGINT <sessionName>`. Regression tests added for this
case failed before the implementation change and passed after mapping Docker
stop to `docker stop <sessionName>`.
