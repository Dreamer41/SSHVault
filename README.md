# SSHVault

> The love child of WinSCP, Termius and MobaXterm. It has its mother's file browser, its father's good looks, and an uncle who shows CPU graphs at the bottom of the screen.

A personal project that got out of hand, built because I wanted one SSH app that does everything and doesn't make me log in to anything. It works well enough that I use it every day, so you can too. Free, no accounts, no telemetry, no "upgrade to Pro" button hiding in a corner.

## What it does

- **Encrypted vault.** Hosts, keys, S3 credentials and snippets are locked behind one master password (scrypt + AES-256-GCM). Forget the password and they stay locked forever. That is a feature, not a bug.
- **Terminal.** Tabs, copy/paste that behaves, and **split panes** side by side or stacked.
- **Reboot-proof.** Server restarted? It retries 5 times by itself, then shows a big Reconnect button. Patience, automated.
- **MobaXterm-style status bar.** CPU, memory, network, uptime, who's logged in and disk usage, live, at the bottom.
- **Key vault.** Generate ed25519 keys, import OpenSSH/PEM keys, and import PuTTY `.ppk` files so you don't have to convert a decade of keys.
- **Snippets.** Common Ubuntu commands ready to go, your own commands, and a "recently used" list at the top.
- **SFTP browser.** Two panes, drag and drop between *different* servers (or your PC, or S3), with progress, speed and ETA. A start folder per server, so it opens where you actually work.
- **S3 buckets.** Browse an existing bucket with an access key, including Glacier / Deep Archive restore.
- **Custom commands** like WinSCP, plus the one I wanted most: **compress → upload to S3 → verify → delete the local copy**. Select a pile of folders and each gets its own `.tgz` (months stay separate), one by one or several at once. Nothing is deleted until the upload size is verified.
- **Host key checking.** Trust on first use, and a loud warning if a server's key changes.
- **Port forwarding.** Local, remote and SOCKS5, with auto-reconnect.
- **Backup / move.** Export everything to one encrypted file and import it on another computer.

## Install

Grab the latest `SSHVault Setup x.y.z.exe` from [Releases](../../releases) and run it. Pin it to the taskbar and feel organized.

Windows may show a "Windows protected your PC" screen. The installer isn't code-signed because certificates cost money and this is a free hobby. Click *More info → Run anyway* if you trust it (the source is right here, so you can check).

## Run from source

```bash
npm install
npm start
```

Build the installer yourself:

```bash
npm run dist
```

## Good to know

- Everything is stored locally. The app only talks to the servers you tell it to.
- Backup files contain your private keys (encrypted with the backup password). Don't leave them on a USB stick in a café.
- Built for Windows. Electron means it might run elsewhere, but I haven't tried, so no promises.
- It's a personal project: it does what I need, and bug reports and ideas are welcome, but I may be slow. No warranty. If it deletes your server, that's between you and your backups.

## License

MIT. Free to use, change and share.
