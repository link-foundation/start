"""Provision a repo-only release deploy key; private bytes never enter logs/history."""
import json
import subprocess
import tempfile
from pathlib import Path

repository = "link-foundation/start"
data = Path("docs/case-studies/issue-197/data")
with tempfile.TemporaryDirectory(prefix="start-release-main-") as directory:
    key = Path(directory) / "release-key"
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "start-release-main", "-f", str(key)], check=True)
    request = Path(directory) / "request.json"
    request.write_text(json.dumps({"title": "Main release automation (issue 197)", "key": Path(str(key) + ".pub").read_text().strip(), "read_only": False}))
    result = subprocess.run(["gh", "api", f"repos/{repository}/keys", "--method", "POST", "--input", str(request)], check=True, capture_output=True, text=True)
    deployed = json.loads(result.stdout)
    try:
        subprocess.run(["gh", "secret", "set", "START_RELEASE_SSH_KEY", "--repo", repository, "--env", "release-main"], input=key.read_bytes(), check=True, capture_output=True)
    except Exception:
        subprocess.run(["gh", "api", f"repos/{repository}/keys/{deployed['id']}", "--method", "DELETE"], check=True, capture_output=True)
        raise
    (data / "release-deploy-key-response.json").write_text(json.dumps({name: value for name, value in deployed.items() if name != "key"}, indent=2) + "\n")
    fingerprint = subprocess.run(["ssh-keygen", "-lf", str(key) + ".pub"], check=True, capture_output=True, text=True).stdout
    (data / "release-deploy-key-fingerprint.txt").write_text(fingerprint)
    print(f"Registered repository-only release key {deployed['id']} in main-restricted release environment.")
# TemporaryDirectory unlinks all private/public key files on every exit.
