# Sync Room

**Listen to your own music together, in sync, on every device. Your songs never leave your computer.**

Run it on your PC or Mac, pick a music folder, and friends join from their phones by scanning a QR code. Everyone hears the same song at the same moment, with synced lyrics. No accounts, no cloud, no uploads.

<p align="center">
  <img src="docs/screens/desktop-library.png" alt="Sync Room on a computer" width="800">
</p>

## Download

- **Windows, nothing to install:** get **`sync-room-v1.0.0-windows-portable.zip`** from the [latest release](../../releases/latest), unzip it, and double-click **`start.bat`**.
- **Mac, Linux, or from source:** needs [Node.js 22+](https://nodejs.org).

  ```bash
  git clone https://github.com/jrayaz/sync-room.git
  cd sync-room
  npm install --omit=dev
  node server.js
  ```

  Prefer a double-click? Run `chmod +x start.command` once, then open `start.command` (on Windows with Node installed, use `start.bat`).

## Quick start

1. Start the app, open **<http://localhost:3000>** on that computer, and tap **Start listening**. Opening it on the host as `localhost` makes you the admin.
2. Click **Change folder** and choose your music folder (browse, or paste a path).
3. Click the **QR icon**. Friends on the same Wi-Fi scan it and tap **Start listening**.

Allow **Private networks** in the Windows firewall prompt (or incoming connections on macOS) so phones can reach the computer.

<p align="center">
  <img src="docs/gifs/invite.gif" alt="Opening the invite QR code" width="520">
  &nbsp;&nbsp;
  <img src="docs/gifs/phone-join.gif" alt="A phone joining the room" width="230">
</p>

## What you can do

- **Play in sync.** Pause, seek or skip on one device and all follow. A per-device **Trim** fixes Bluetooth delay.
- **Browse your music.** Songs and Folders views, search, and real titles and cover art from your files' tags. The admin can upload and delete.
- **Read synced lyrics** that scroll with the song (from a `.lrc` file or [LRCLIB](https://lrclib.net)).
- **Share control.** One switch, **Everyone** or **Admin only**, decides who can play, skip and upload.

<p align="center">
  <img src="docs/gifs/browse.gif" alt="Folders, search and the folder picker" width="700">
</p>

<p align="center">
  <img src="docs/gifs/lyrics.gif" alt="Lyrics scrolling with the song" width="700">
</p>

## Admin and guests

No passwords. The computer running the app is the **admin**; everyone else who joins is a **guest**.

| | Admin | Guest |
|---|---|---|
| Listen, rename yourself, lyrics, trim | yes | yes |
| Play, seek, skip, upload | yes | only if the switch is **Everyone** |
| Change folder, delete songs, change the switch | yes | no |

## Controls

`Space` play/pause · `N` next · `P` previous · `L` lyrics · `/` search · `Esc` close. On phones, tap the small player bar for the full screen.

## Lyrics

Lyrics come from a `.lrc` file next to the song, then from LRCLIB. Only **time-synced** lyrics are shown. The lookup is done by the host only and sends just the title and artist; turn **Lyrics lookup** off in the sidebar and nothing is sent.

## Getting tight sync

Each device is aligned to the host's clock and re-aimed if it drifts more than about 25 ms. For the best result use each device's own speaker or a wire. If one device is still early or late, nudge **Trim** in the sidebar.

## Privacy

- Songs stream only from your chosen folder, over your own network.
- No CDN, fonts, analytics or trackers. The QR code is made locally.
- The only optional outside request is the lyrics lookup above.
- Keep it on your home Wi-Fi or a private network such as [Tailscale](https://tailscale.com). **Don't expose it to the public internet.**

## Troubleshooting

- **A phone can't open the link:** is it on the same Wi-Fi (not a guest network)? Did you allow the firewall prompt?
- **No sound:** tap **Start listening**; browsers require one tap.
- **A device is slightly off:** use its own speaker and adjust **Trim**.
- **No admin buttons:** open the app as `http://localhost:3000` on the host computer.
- **No lyrics:** only synced lyrics are shown; check that **Lyrics lookup** is on, or add a `.lrc` file.
- **Port in use:** set another port, for example `PORT=3001 node server.js`.

## Settings

`config.json` is created on first run: `port` (3000), `musicDir` (`music`), `maxUploadMB` (300), `lyricsOnline` (true). Most are set from the app.

## Help

Found a bug? [Open an issue](../../issues) with your OS, browser, and what happened.

## Credits and license

Inspired by [Beatsync](https://github.com/freeman-jiang/beatsync). Lyrics by [LRCLIB](https://lrclib.net). The Windows portable build bundles an unmodified Node.js runtime (MIT, see `runtime/LICENSE-node.txt`). Demo songs in the screenshots are generated tones. Released under the [MIT License](LICENSE).
