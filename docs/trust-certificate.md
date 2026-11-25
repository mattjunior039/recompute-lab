# Trust the Hub's certificate (one time per device)

**Why:** browsers only allow the fast features (multi-core AI, the live camera, saving models on the device, WebGPU) on a **secure (https)** page. Normally that needs a certificate from an internet company. Recompute works offline instead: the Hub makes its own small certificate authority called **"Recompute Local CA"**, and each device is told to trust it once.

- The certificate and its private key never leave the Hub computer. They're stored in `.recompute/certs/`.
- It only vouches for the Hub on your own network. There's no account and nothing in the cloud.
- **Skipping this is OK.** The "basic (http)" address still works for Swarm Sort and Science Sweep, just slower. The camera becomes a "take photo" button.

---

## Before you start (on the Hub computer)
1. Start the Hub with `npm run hub`.
2. Open the Console at `http://localhost:8080/console`.
3. Under the big QR code, click **"First time on a device? Trust the Hub"**. A second QR code appears. It opens the **trust page** (`http://<Hub address>:8080/trust`).
4. The Terminal window shows a line `CA fingerprint (SHA-256): CB:10:…`. The trust page shows the same fingerprint. If they match, the certificate really came from your Hub.

The trust page detects the device and shows the right steps, plus a **"Test the secure connection"** button. Use that button at the end to confirm it worked.

---

## Chromebook (ChromeOS)
1. Scan the trust QR code with your phone and type the address into the Chromebook, or type it directly. It looks like `http://192.168.x.x:8080/trust`.
2. Click **⬇ Download the certificate**. The file `recompute-ca.crt` goes to **Downloads**.
3. Open the certificate settings. Either:
   - type **`chrome://certificate-manager`** in the address bar, or
   - go to **Settings → Privacy and security → Security → Manage certificates** (on some versions: **Manage device certificates**).
4. Import it. The layout depends on your ChromeOS version:
   - **Classic layout (tabs at the top):** click the **Authorities** tab → **Import** → pick `recompute-ca.crt` from Downloads → tick **"Trust this certificate for identifying websites"** → **OK**.
   - **Newer layout (left menu):** click **Local certificates** (or **Your certificates**) → **Installed by you** → **Trusted certificates → Import** → pick `recompute-ca.crt`.
5. Check that **"Recompute Local CA"** (under "org-Recompute" in the classic list) now appears in the list.
6. Go back to the trust page and click **Test the secure connection**. It should say it's trusted, then click **Continue to the lab →**.

> ⚠ A **school-managed** Chromebook may block importing certificates. That's an admin policy, not a bug. Use basic (http) mode on that device, or use a personal Chromebook.

## iPhone (iOS)
**You must use Safari** for steps 1–2. iOS only installs profiles downloaded in Safari.
1. Scan the trust QR code with the Camera app, then tap the link (it opens in Safari).
2. Tap **⬇ Download the certificate**. iOS asks *"This website is trying to download a configuration profile. Do you want to allow this?"* Tap **Allow**, then **Close**.
3. Open **Settings**. Near the top there's a new line, **Profile Downloaded**. Tap it.
   - If you don't see it: **Settings → General → VPN & Device Management**, then tap **Recompute Local CA**.
4. Tap **Install** (top right), enter your passcode, then tap **Install** again (and once more on the warning screen). Tap **Done**.
5. **⚠ The step everyone misses:** **Settings → General → About**, scroll to the bottom, then **Certificate Trust Settings**. Turn **ON** the switch for **Recompute Local CA**, then tap **Continue**.
6. Go back to Safari, then the trust page, and tap **Test the secure connection**. Then tap **Continue to the lab →**.

To undo it later: **Settings → General → VPN & Device Management → Recompute Local CA → Remove Profile**.

## Mac (an old MacBook, or the Hub computer itself if it's a Mac)
The Hub computer can always use `http://localhost:8080/...`, which browsers already treat as secure, so it doesn't need this.
1. Download the certificate from the trust page, then double-click `recompute-ca.crt`. **Keychain Access** opens. Add it to the **login** keychain.
2. In Keychain Access, find **Recompute Local CA** and double-click it. Expand **Trust** and set **"When using this certificate"** to **Always Trust**. Close the window and enter your Mac password.
3. Safari and Chrome now trust it. (Firefox has its own list: **Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import**.)

## Windows laptop
1. Download the certificate, then double-click `recompute-ca.crt`, then **Install Certificate…**, then **Current User**.
2. Choose **Place all certificates in the following store**, then **Browse… → Trusted Root Certification Authorities**, then **Next → Finish → Yes**.
3. Close and reopen the browser.

## Android (if you use one)
**Settings → Security → Encryption & credentials → Install a certificate → CA certificate**, then pick `recompute-ca.crt`.

---

## Good to know
- **The Hub computer's Wi-Fi address can change.** If it does, the Hub makes a new server certificate by itself. Devices don't need to trust anything again, because they trust the Local CA, not the address. Just rescan the QR code.
- **Deleting `.recompute/`** on the Hub computer makes a brand-new CA. Then every device has to trust it again, and you should remove the old one.
- **Why not mkcert?** mkcert does the same thing (a local CA plus a certificate for the Hub), but it needs Homebrew and extra installs on the Hub computer. Recompute builds the same kind of certificate itself, so `npm run hub` is the only command.
