# Request2.0

A Discord slash-command bot for requesting movies, TV shows, and anime through Radarr and Sonarr.

## How it works

- `/request type:Movie title:...` searches Radarr.
- `/request type:TV show title:...` searches Sonarr as a standard series.
- `/request type:Anime title:...` searches Sonarr and adds the result with Sonarr's `anime` series type.
- Search matches include available poster art, overview, year, genres, and ratings. The requester can preview a match and confirm before it is sent to the media manager.
- `/my-requests` privately shows the user's 10 most recent requests and their current statuses. Older history remains available in the desktop dashboard.
- `/cancel-request` lets a requester mark one of their active requests as cancelled. This only updates Request Bot history; it does not remove media from Radarr/Sonarr or stop a download.
- `/retry-request` lets members with Discord's **Manage Server** permission choose a failed or stalled request and, after confirmation, start a new search in Radarr or Sonarr.
- If the selected movie or series is already in Radarr or Sonarr, the bot tells the requester privately and does not add it or start another search.
- Successful requests and completed downloads are announced in the configured Discord alert channel. Requesters are also mentioned there when their request starts downloading, completes, or needs attention.
- Jellyfin is not called directly. Configure Jellyfin to scan the same media library locations used by Radarr/Sonarr; the media appears after import and a Jellyfin library scan.

## Setup

1. Use Node.js 18 or newer.
2. Create `.env` from `.env.example`. If `.env` already exists, keep its private values and add the missing settings from `.env.example` rather than overwriting it.
3. Create a Discord application and bot, invite it to your server with the `bot` and `applications.commands` scopes, and fill in `DISCORD_TOKEN`, `CLIENT_ID`, and `GUILD_ID`.
4. Set `RADARR_URL` and `RADARR_API_KEY`, and `SONARR_URL` and `SONARR_API_KEY`. The API keys are available in each manager's settings.
5. Set each manager URL to an address reachable from the machine running this bot. If a service is running in Docker, `localhost` inside the bot container will not refer to that service; use the correct container/network address.
6. Register the slash command in the target server and start the bot:

   ```text
   npm run deploy
   npm start
   ```

7. To announce successful requests, request status changes, and completed Radarr/Sonarr downloads, set `ALERT_CHANNEL_ID` to the target text channel ID in `.env`. Give the bot permission to view the channel and send messages; request status updates mention the requester.

Request limits and channel restrictions are optional. Set `REQUEST_MAX_ACTIVE_PER_USER` to a whole number from 1 to 9999 to cap each Discord user's active requests; leave it blank or unset for no limit. Set `REQUEST_ALLOWED_CHANNEL_IDS` to comma-separated Discord text-channel IDs to restrict `/request`; leave it blank or unset to allow requests in any channel. Register the commands again with `npm run deploy` after updating the bot.

`npm start` automatically restarts the bot after an unexpected error exit, waiting five seconds before retrying. Press Ctrl+C to stop it.

## Desktop download dashboard

The desktop app runs on Windows, macOS, and Linux. Install dependencies and build on the operating system you want to package:

- Windows: `npm run dist:win` creates an installer in `dist/`.
- macOS: `npm run dist:mac` creates DMG and ZIP packages for Intel and Apple silicon.
- Linux: `npm run dist:linux` creates AppImage and Debian packages.

The Windows installer creates desktop and Start menu shortcuts. Packages do not include `.env` or your local request history. macOS packages are unsigned; macOS may require you to approve the app in Privacy & Security before opening it.

Automatic desktop updates are not enabled yet. They require a GitHub repository with published Releases; configure the updater after the app repository has been created.

On first launch, a welcome screen guides new users through setup; choose **Let's get started** to open Settings or **Set up later** to continue to the dashboard. Use the **gear** any time to configure Discord, Radarr, Sonarr, and an optional torrent client: qBittorrent, Transmission, Deluge, or BitTorrent/µTorrent Classic. Use the connection-test buttons, save settings, then choose **Register Discord commands**. Discord needs the bot token, application ID, and server ID; invite the bot to the server with the `bot` and `applications.commands` scopes. Radarr and Sonarr API keys are available in their settings. Enable Web UI/RPC access in your torrent client; qBittorrent, Deluge, and BitTorrent/µTorrent Classic require credentials, while Transmission credentials are optional if authentication is disabled. For BitTorrent/µTorrent, use the Classic desktop client with its Web UI enabled; other BitTorrent-branded clients may not expose the same API. Enter service URLs reachable from the PC running the app (for example `http://localhost:7878`, `http://localhost:8989`, or the Web UI/RPC port configured for your torrent client). Root folders and quality-profile IDs are optional when the manager has exactly one choice; set them if it offers multiple choices.

Settings includes **Check all connections** for Discord, Radarr, Sonarr, and a configured torrent client. **Load folders & profiles** retrieves available Radarr/Sonarr choices after the manager is reachable. Optional request restrictions are configured in the Discord settings. The dashboard provides activity counts, request-history search and status filters, CSV export, and a confirmed **Clear history** action. History is kept indefinitely unless manually cleared. Cancelling a request only changes its history status; it never deletes a media-manager entry or torrent. History tools do not affect Radarr, Sonarr, or the torrent client.

Connection settings and API secrets use Electron's operating-system secure storage and are kept in the current user's application data. On Linux, a supported desktop keyring service (GNOME Keyring/libsecret or KWallet) is required; the app will not save credentials using Electron's insecure `basic_text` fallback. The dashboard stores request history in that same per-user data folder. The desktop app does not require a `.env` file; the existing command-line bot setup below still uses `.env`.

The dashboard shows current Radarr/Sonarr and selected torrent-client activity, recent media imports, and request history with requester and status details. Queue errors and stalled states include the explanation returned by the media manager when available. The **Update trackers** button asks the selected torrent client to reannounce trackers for all torrents; trackers may still enforce their own announce intervals. The dashboard refreshes every 30 seconds and can be shown or hidden with **Ctrl+Shift+D** on Windows/Linux or **Command+Shift+D** on macOS. Use the dashboard's minimize, maximize/restore, and hide buttons to manage its window. Hiding the window keeps the app running in the background. Use the Request Bot tray icon to open the dashboard or quit the app and bot.

The **Personal media sync** card can run separate scripts for TV shows and movies: Windows `.bat` files or macOS/Linux `.sh` files. Choose each script and use its **Start** or **Stop** controls independently; script paths are saved in the current user's encrypted settings, and the scripts remain on that computer rather than being included in the installer. The app stops running sync processes when it exits. The provided `TV Show mover.bat` is Windows-only; on macOS or Linux, choose your own shell scripts.

To control the dashboard from an Elgato Stream Deck, add a **System > Hotkey** action to a key and assign the platform shortcut above. The dashboard app must be running in the background.

Radarr/Sonarr root folders and quality profiles are selected automatically when there is exactly one of each. If a manager has multiple choices, fill in its corresponding variables in `.env`. Root-folder values must exactly match a path returned by the manager; quality-profile values are the numeric profile IDs.

The configured Radarr and Sonarr instances have a separate `HD 720p+ (Best Available)` profile selected for new requests. It allows 720p, 1080p, and 2160p, with upgrades enabled through the 2160p Remux cutoff. The bot's `.env` profile IDs are specific to these manager instances. This asks Radarr/Sonarr to prefer the highest allowed quality they can find; actual availability still depends on the configured indexers and download clients.

| Manager | Root folder | Quality profile ID |
| --- | --- | --- |
| Radarr | `RADARR_ROOT_FOLDER` | `RADARR_QUALITY_PROFILE_ID` |
| Sonarr TV | `SONARR_TV_ROOT_FOLDER` | `SONARR_TV_QUALITY_PROFILE_ID` |
| Sonarr anime | `SONARR_ANIME_ROOT_FOLDER` | `SONARR_ANIME_QUALITY_PROFILE_ID` |

For a Sonarr TV/anime setting that is not specified separately, the bot falls back to `SONARR_ROOT_FOLDER` or `SONARR_QUALITY_PROFILE_ID`. Do not commit `.env` or share its contents; keep API keys and the Discord token private.
