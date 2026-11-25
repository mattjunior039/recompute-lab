# IT admin guide

This page is for school IT staff evaluating or deploying Recompute. In short: Recompute is a web app served from one computer on your local network. Student devices open it in the browser. There's nothing to install on student devices, there are no accounts, and there's no cloud service.

## What runs where
| Part | What it is | Network |
|---|---|---|
| **Hub** | A Node.js (≥ 22.13) server on one computer: a staff laptop, a desktop, or an old PC | Listens on TCP **8080** (http) and **8443** (https) on the LAN |
| **Node** | A browser page (`/join`) that runs built-in compute kernels in Web Workers | Connects only to the Hub, over WebSocket (star topology) |
| **Console** | A browser page (`/console`) on the Hub computer | Same |

- **Outbound internet** is needed only for setup: `npm install` (registry.npmjs.org) and the first model download from **huggingface.co** (about 410 MB, over HTTPS 443). After that the whole lab works with the internet unplugged.
- **No peer-to-peer.** Devices never talk to each other, only to the Hub, so no WebRTC or extra ports are needed.
- **No analytics or telemetry.** Recompute doesn't contact any third party during lessons.

## Network checklist
1. **The Hub and student devices must reach each other on the same LAN/SSID.** Many school and guest SSIDs enable *client isolation* (AP isolation), which blocks device-to-device traffic. Either allow traffic from the SSID to the Hub's IP on TCP 8080/8443, or use a dedicated router or SSID for the lab.
2. **Give the Hub a stable IP** (DHCP reservation). The join QR code contains the Hub's IP address; if it changes, students rescan.
3. **Hub computer firewall:** allow incoming connections for Node.js on *private* networks (macOS asks the first time; on Windows, allow it on "Private networks" in the Defender Firewall prompt).
4. **Bandwidth:** on first use, each device downloads the image model (about 21 MB) and the photo set (about 14 MB) from the Hub. Each device that loads the tutor downloads 370–470 MB from the Hub. It's all LAN traffic, and devices cache it in browser storage.
5. **Web filters / SSL inspection:** traffic stays on the LAN, but if a filtering agent on the Chromebooks proxies all traffic, add the Hub's IP (`http://<hub-ip>:8080` and `https://<hub-ip>:8443`) to its bypass list.

## Why there's a certificate (and how to push it)
Browsers only enable multi-threaded WebAssembly, the camera, offline storage, and WebGPU on **secure (https)** pages. Because Recompute must work offline, the Hub creates its own small certificate authority, **"Recompute Local CA"**, valid only for that Hub. Its private key never leaves the Hub computer (`.recompute/certs/`).

- **Without the certificate**, devices can use the basic http address. Swarm Sort and Science Sweep still work single-threaded, the camera becomes a "take photo" button, and the tutor runs slower. Every page shows a clear banner when it's in this mode.
- **Manual trust per device:** see [trust-certificate.md](trust-certificate.md) (ChromeOS, iOS, macOS, Windows, Android).
- **Managed Chromebooks (Google Admin console):**
  1. Copy `recompute-ca.crt` from the Hub's trust page (`http://<hub-ip>:8080/trust`). Compare its SHA-256 fingerprint with the one the Hub prints at startup.
  2. Go to **Devices → Networks → Certificates**, choose the organizational unit (OU) for the lab devices, then click **Add certificate** and upload it.
  3. Under **Certificate authority**, tick **Chromebook** ("use this certificate as an HTTPS certificate authority") and save.
  4. Scope this to a lab OU, not the whole domain: it's a CA your school controls on one machine.
  - If you delete the Hub's `.recompute/` folder, it creates a new CA, and you must replace the pushed certificate.

## Chrome / ChromeOS policies to check
These are the policies that most often block Recompute on managed devices. Settings in the Admin console are under **Devices → Chrome → Settings** (Users & browsers, or Device) for the lab OU. Names in parentheses are the underlying Chrome policies.

| What Recompute needs | Policy to check |
|---|---|
| Open the Hub's pages | **URL blocking** (`URLBlocklist` / `URLAllowlist`): if you run an allowlist, add `http://<hub-ip>:8080` and `https://<hub-ip>:8443`. |
| Cache models and photos on the device | **Cookies / site data** (`DefaultCookiesSetting`): if site data is blocked, allow the Hub origin (`CookiesAllowedForUrls`). Otherwise devices re-download models every visit. |
| Teach the Swarm camera | **Video input** (`VideoCaptureAllowed`, `VideoCaptureAllowedUrls`): allow the Hub's https origin. |
| Keep the screen on in Reborn/cart mode | **Screen wake locks** (`AllowScreenWakeLocks`) and the idle/power settings for the cart OU. If wake locks are disabled, the page can't keep the screen awake and the device may sleep mid-job. |
| Optional: start cart devices straight into Reborn mode | **Pages to load on startup** (`RestoreOnStartupURLs`) set to `https://<hub-ip>:8443/join?mode=reborn&room=…` for a dedicated cart OU. |

WebGPU is optional: Recompute uses WebAssembly first and only uses WebGPU when a device reports a working adapter.

## Security and privacy summary
- No accounts, no names required, and no personal data collected. Devices get a random ID and a generic name based on the device type (for example "Chromebook 1"); the teacher can rename a device from the Console.
- Nodes run only **built-in** compute kernels shipped with the app. The Hub never sends code to devices, only data and kernel names.
- Models are pinned to a fixed version and checked against a SHA-256 hash before they're served; mismatches are rejected.
- Teach the Swarm photos stay on the device that took them. Only model weights go to the Hub.
- The Hub stores jobs, results, benchmark numbers, and (optional) measured watts in a local SQLite file under `.recompute/`. Delete that folder to wipe everything.
- See also [SECURITY.md](../SECURITY.md) for how to report a vulnerability.

## Device safety settings built in
- Each device uses all CPU cores but one.
- Devices pause when unplugged, where the browser exposes the Battery API (Chrome/ChromeOS). Safari doesn't, so the page shows the charging state as "unknown" and keeps computing; keep those devices plugged in.
- If work chunks start taking longer (a sign of heat throttling), the device backs off.
- Every device has a big **STOP** button, and the Console can stop every job.

## AUE, expired Chromebooks, and Reborn mode
Every ChromeOS device has an **Auto Update Expiration (AUE)** date; after it, the device gets no more ChromeOS or browser updates. Check it at **Settings → About ChromeOS → Additional details → Update schedule**, or in Google's [AUE policy list](https://support.google.com/chrome/a/answer/6220366).

**Reborn R1 (recommended):** open `/join?mode=reborn` on an expired Chromebook. It becomes a full-screen, compute-only node for a charging cart. Because expired devices no longer get security fixes:
- put them on a **separate lab SSID or VLAN** that can reach only the Hub (no internet needed after setup);
- don't sign students into them; use a guest or a dedicated, locked-down OU;
- use them only for Recompute compute, not for browsing.

**Reborn R2 (Linux reflash):** documented in [reborn-r2-linux.md](reborn-r2-linux.md) for *owned, already-expired, de-provisioned* devices only. It can brick a device and requires firmware changes. Recompute doesn't automate it, and it isn't required.

## Battery and cart safety
Old devices often have old batteries. Recompute's charge-only and thermal back-off settings help, but they're **no substitute for physical checks**.
- **Inspect before use.** Look for a swollen battery: a case that bulges, a lifted keyboard or trackpad, gaps at the seams, or a device that rocks on a flat table. If you see any of these, take the device out of service right away.
- **Never charge, puncture, or press on a swollen battery.** Store it in a non-flammable container away from flammables, and send it to a proper battery recycler (in the US, for example, through Call2Recycle or your district's hazardous-waste program).
- **Ventilate carts.** Leave cart doors open while devices compute. Don't stack devices or cover vents.
- **Supervise.** Run compute jobs during staffed hours. Don't leave old devices computing unattended overnight.
- **Retire responsibly.** When a device is finally done, send it to a certified electronics recycler (R2v3 or e-Stewards; R2v3 is a recycling standard, unrelated to "Reborn R2").

## Measuring energy (optional)
Recompute never estimates power use. If your school has a plug-in power meter, you can enter idle and busy watts per device under **Console → Benchmarks → Optional: measured watts**. Recompute then shows energy per job calculated only from those readings. With no readings entered, no energy numbers are shown.
