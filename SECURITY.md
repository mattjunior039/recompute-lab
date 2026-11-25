# Security policy

Recompute runs in schools, so we take security reports seriously.

## Reporting a vulnerability
Please **don't** open a public issue. Use GitHub's private reporting instead: go to the repository's **Security** tab and choose **Report a vulnerability**. Include:
- what an attacker could do, and from where (same Wi-Fi? same device?);
- steps to reproduce;
- the Recompute version or commit, and the browsers/devices involved.

We'll acknowledge the report as soon as we can and keep you updated while we work on a fix.

## Supported versions
Only the latest commit on `main` gets security fixes.

## Security model (what to expect)
- The Hub is meant for a **trusted local network**. Anyone who can reach it and knows the 6-digit room code can join as a node or view the Console.
- Nodes run **only built-in kernels**. The Hub sends data and kernel names, never code. A report showing remote code execution on a node is in scope.
- Models are pinned and checked against SHA-256 hashes before the Hub serves them.
- The Hub's local CA private key stays in `.recompute/certs/` on the Hub computer. Anyone with that key can impersonate HTTPS sites to devices that trust the CA, so protect the Hub computer and delete the folder to rotate it.
- Teach the Swarm photos stay on the device; only model weights are sent to the Hub.
