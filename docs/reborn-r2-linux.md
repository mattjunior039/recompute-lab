# Reborn R2: giving an expired Chromebook a Linux afterlife (documentation only)

> ## ⚠ Read this first
> - **This can permanently brick a Chromebook.** One mistake, a dead battery, or a power cut while flashing, and the laptop may never turn on again without special tools.
> - **Only do this to a Chromebook that is already past its Auto Update Expiration (AUE) and that you own.** Never do it to a device that still gets updates, to a school-owned device, or to anyone else's device without the owner's written permission.
> - **School-managed (enrolled) Chromebooks can't and shouldn't be done.** Enrollment blocks the needed steps, and it's school property. Ask IT to de-provision it first. That's their decision.
> - **It erases everything on the device.**
> - Ask a parent or guardian, and ideally do it with an adult who's comfortable with computers.
> - Recompute **doesn't automate any of this**, on purpose. This page only explains the path.

## You may not need R2 at all
**Reborn R1** is just Recompute's `?mode=reborn` page. It already works on an *expired* Chromebook, because Chrome keeps running after the AUE date; it just stops getting updates. For a charging-cart compute node on a private classroom network, R1 is usually enough:
1. Open the join link with `&mode=reborn` added. The Console shows the full Reborn address under **Setup → Addresses**.
2. Tap **Full screen**. Keep it plugged in.

R2 matters when you want a *supported, updated* operating system on that hardware again. Then the device can run a current Linux browser with security updates, and Recompute runs there the same way.

## What R2 is
[MrChromebox](https://docs.mrchromebox.tech) is a long-running community project. It replaces a Chromebook's firmware (the startup software) with a standard **UEFI** firmware, so you can install a normal Linux distribution instead of ChromeOS.

**The two firmware options:**
- **RW_LEGACY:** adds a way to boot Linux next to ChromeOS. It's less invasive, needs no write-protect removal, and is reversible, but ChromeOS stays on the device.
- **UEFI Full ROM:** replaces the firmware completely, and ChromeOS is gone. It needs the hardware **write protection** turned off first. This is the "full second life" option, and the riskiest.

## The path, at a high level
Always follow the **current official MrChromebox docs**, not this summary. Steps and tools change.
1. **Check support.** Boot to the recovery screen and note the **board name**, the first word of the HWID (e.g. `BOARDNAME`, a single capitalized word). Find it in [MrChromebox Supported Devices](https://docs.mrchromebox.tech/docs/supported-devices.html). If it's not listed, stop.
2. **Check Linux compatibility** for that board on the [chrultrabook devices page](https://docs.chrultrabook.com/docs/devices.html). Audio and some keys may not work on every model.
3. **Back up** anything you want to keep. The whole disk gets erased.
4. **Make a Linux USB stick** on another computer, e.g. Ubuntu, Fedora, or a lightweight distro like Xubuntu or Linux Mint XFCE, which suit 4–8 GB machines.
5. **Enable Developer Mode** on the Chromebook. This wipes it.
6. **(Full ROM only) Disable hardware write protection.** The supported-devices table lists the method for each board: battery disconnect, a jumper or screw, `gsctool`, or a SuzyQ cable. Opening the case can void any warranty and risks damaging ribbon cables. Follow MrChromebox's [disabling write protection](https://docs.mrchromebox.tech/docs/firmware/wp/disabling.html) page exactly.
7. **Run the MrChromebox Firmware Utility Script** from the developer shell as described on its site, and choose RW_LEGACY or UEFI Full ROM. **Save the firmware backup it offers to a USB stick and keep it safe.** That backup is your way back.
8. **Boot the Linux USB and install.**
9. **Open Chrome or Chromium on Linux**, go to the Recompute join link, and add `&mode=reborn`. Trust the Hub certificate the same way as in Chrome on a Chromebook (`chrome://certificate-manager` → import; see [trust-certificate.md](trust-certificate.md)).

## Safety checklist
- [ ] The device is expired, is mine, and is not enrolled or managed.
- [ ] A parent/guardian knows and agrees.
- [ ] The charger is plugged in for the whole process, and the battery is above 50%.
- [ ] The firmware backup is saved on a USB stick *and* copied to another computer.
- [ ] I've read the current MrChromebox docs for my exact board name.
- [ ] I accept that it may not work and the device may be unrecoverable.
- [ ] Batteries: if you open the case, never puncture, bend, or pry a swollen battery. If a battery looks swollen, stop and take it to proper battery recycling (that's the Teach the Swarm "battery hazard" class in real life).

## How to describe it
Describe R2 as an *option* for truly expired hardware, with the risks stated. The honest claim is: "Recompute runs in any modern browser, so an expired Chromebook can keep contributing as a Reborn node (R1). For a fully updated OS, community firmware such as MrChromebox can let it run Linux (R2), at your own risk."
