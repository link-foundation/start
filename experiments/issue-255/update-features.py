"""Add the formal-ai feature (issue #255) and version_info.rs to parity/features.json."""
import json
import sys

path = sys.argv[1]
data = json.load(open(path, encoding="utf-8"))
features = data["features"]
BLOCKERS = [
    f"https://github.com/link-foundation/meta-language/issues/{n}"
    for n in (222, 223, 204, 206, 207, 208, 209, 212)
]
CONTRACT = (
    "its JavaScript contract uses CommonJS and native Node/Bun adapters, "
    "async/await scheduling, optional/nullish fields, dynamic object/JSON records, "
    "callbacks and closures, array/list operations, string operations, try/catch, "
    "switch, destructuring. See the feature's anchored translationBlockers; "
    "carried code is not executable Rust."
)


def manual(path, kind, feature):
    return {
        "path": path,
        "reason": f"{kind} for {feature}; {CONTRACT}",
        "blockers": BLOCKERS,
    }


ADAPTER = "Native filesystem/process adapter"
TYPED = "Typed native representation and control flow"

cli = next(f for f in features if f["id"] == "cli")
if "rust/src/lib/version_info.rs" not in cli["rust"]["implementation"]:
    cli["rust"]["implementation"].append("rust/src/lib/version_info.rs")
    cli["manualRust"].append(manual("rust/src/lib/version_info.rs", ADAPTER, "cli"))

features[:] = [f for f in features if f["id"] != "formal-ai"]
rust_files = [
    ("rust/src/lib/formal_ai.rs", TYPED),
    ("rust/src/lib/formal_ai_cli.rs", ADAPTER),
    ("rust/src/lib/formal_ai_client.rs", ADAPTER),
    ("rust/src/lib/formal_ai_policy.rs", ADAPTER),
    ("rust/src/lib/formal_ai_runtime.rs", ADAPTER),
    ("rust/src/lib/formal_ai_tool.rs", ADAPTER),
    ("rust/src/lib/formal_ai_cases.rs", ADAPTER),
    ("rust/src/lib/formal_ai_policy_cases.rs", ADAPTER),
]
feature = {
    "id": "formal-ai",
    "javascript": {
        "implementation": [
            "js/src/lib/formal-ai.js",
            "js/src/lib/formal-ai-cli.js",
            "js/src/lib/formal-ai-client.js",
            "js/src/lib/formal-ai-policy.js",
            "js/src/lib/formal-ai-runtime.js",
            "js/src/lib/formal-ai-tool.js",
        ],
        "tests": [
            "js/test/regression-255-policy.js",
            "js/test/regression-255-loop.js",
            "js/test/regression-255-cli.js",
            "js/test/regression-255-e2e.js",
        ],
    },
    "rust": {
        "implementation": [p for p, _ in rust_files],
        "tests": [
            "rust/tests/regression_255.rs",
            "rust/src/lib/formal_ai_cases.rs",
            "rust/src/lib/formal_ai_policy_cases.rs",
        ],
    },
    "manualRust": [manual(p, k, "formal-ai") for p, k in rust_files],
}
index = next(i for i, f in enumerate(features) if f["id"] == "parity-threshold")
features.insert(index, feature)
with open(path, "w", encoding="utf-8") as out:
    json.dump(data, out, indent=2, ensure_ascii=False)
    out.write("\n")
