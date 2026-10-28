# SSHVault

A free, simple SSH client for Windows with a built-in encrypted vault. Termius-style ease, MobaXterm-style status bar, WinSCP-style file browser.

## Features

- **Encrypted vault** (scrypt + AES-256-GCM) for hosts, SSH keys, S3 credentials, snippets and settings, protected by one master password
- **SSH terminal** with copy/paste, tabs, split panes, and automatic reconnect after a server reboot (5 tries, then a Reconnect button)
- **Live status bar**: CPU, memory, network, uptime, users and disks of the server
- **Key vault**: generate ed25519 keys, import OpenSSH/PEM keys and PuTTY `.ppk` files
- **Snippets**: ready-made Ubuntu commands, your own snippets, a "recently used" list
- **SFTP browser**: two panes, drag and drop between different servers, local disk and S3, transfer progress with speed and ETA, per-server start folder
- **S3 buckets** (access key) as a browsable location, including Glacier / Deep Archive restore
- **Custom commands** (WinSCP style) and a one-click **compress → upload to S3 → delete local copy** that archives every selected folder into its own `.tgz`
- **Host key checking** (trust on first use, warning when a key changes)
- **Port forwarding**: local, remote and SOCKS5, with auto-reconnect
- **Backup**: export and import everything to move to another computer

## Install

Download the latest `SSHVault Setup x.y.z.exe` from the [Releases](../../releases) page and run it.

## Run from source

```bash
npm install
npm start
```

Build the installer:

```bash
npm run dist
```

## Security notes

- Everything is stored locally in an encrypted file. Nothing is sent anywhere except to the servers you connect to.
- If you forget the master password the vault cannot be recovered.
- Backup files contain your private keys (encrypted with the backup password). Keep them safe.
- The installer is not code-signed, so Windows SmartScreen may warn on first run.

## License

MIT. Free to use, modify and share.
