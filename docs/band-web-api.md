# BAND web API

The server calls these endpoints, observed from BAND's web app on 2026-11-24. They are undocumented and may change. No member content appears here.

## How the server sends requests

BAND's web app at `www.band.us` is a webpack 4 bundle. Its API client class was module 283 on 2026-11-24, matched as a constructor with `send` and `__send` on its prototype. It adds `akey`, `md`, `language`, and `DEVICE-TIME-ZONE-*` headers and refreshes the session first. `jQuery.ajax` does not sign, and BAND returns `result_code` 300 for unsigned calls.

On page load, `band.ts` wraps `Function.prototype.call` until the first module factory runs, captures webpack's `require`, and restores `call`. It finds the client class and creates `new Client({ bandApi: true })`. `call(endpoint, data, method)` runs `client.send({ url: "https://api.band.us/<endpoint>", data, method })` in the page. The client rewrites `api.band.us` to the regional host, `api-usw.band.us`. One request takes a few hundred milliseconds. The server queues requests one at a time, at least 300 milliseconds apart.

Every response has `result_code`, where 1 means OK, and `result_data`. Seen errors are 200 for bad parameters, 300 for unsigned, 1003 for rate limits, and 2 or 401 when signed out. The server records each called or seen endpoint in `endpoints.json` in the data folder, parameter names only.

## Reads

| Endpoint | Parameters | Returns |
|---|---|---|
| `POST v2.3.0/get_band_list` | none | `items[]` of `{ band: { band_no, name, member_count, … }, member }`, `pinned_band_nos` |
| `GET v2.0.0/get_posts_and_announcements` | `band_no`, `order_by=created_at_desc`, `resolution_type=4`, `limit` of 20 | `items[].post` with `post_no`, `content`, `author`, `created_at` in milliseconds, `comment_count`, `emotion_count`, `read_count`, `photo_count`, `video_count`, `is_notice`, `is_major_notice`, `web_url`, `attachment`, `latest_comment`, `featured_comment`. Pass `paging.next_params` as the next page's full parameters, including `after_post_no` and `after_announcement_created_at`. |
| `GET v2.3.0/get_comments` | `band_no`, `content_key` JSON string, `resolution_type=4` | `items[]` with `comment_id`, `body`, `author`, `created_at`, `comment_count` for replies, `emotion_count`, photos; `total` for comments plus replies; `paging.previous_params` for older comments, or null when done. |
| `GET v1.6.0/get_schedules` | `band_no`, `start_at` and `future_end_at` as `YYYYMMDD`, `calendars=null` | `items[]` with `schedule_id`, `name`, `description`, `start_at`, `end_at`, `location`, `comment_count`, `is_delete`, `calendar`, and more; `paging.next_params`. |
| `GET v2.0.0/get_band_notices` | `band_no`, `limit` | `items[]` with `post_no`, `title`, `is_major`, `notice_created_at`, `post_created_at`, `author`, `read_count`. |
| `GET v2.0.0/get_members_of_band_with_filter` | `band_no`, empty `filter=` | `members[]` with `user_no`, `name`, `profile_image_url`, plus `member_count`. BAND rejects `filter=all` and `filter=member`. |
| `GET v1.6.0/get_upcoming_schedules` | `band_no`, `limit` | Upcoming events. |

The `content_key` parameter accepts these JSON formats:

- Post comments use `{"content_type":"post","post_no":N}`.
- Post comment replies use `{"content_type":"post_comment","post_no":N,"comment_id":C}`.
- Event comments use `{"content_type":"schedule","schedule_id":"4/<band>/<id>/<date>"}`.
- Event comment replies use `{"content_type":"schedule_comment","schedule_id":"…","comment_id":C}`.

Schedule ids starting with `5/` are BAND's public-holiday calendar. Mentions use `<band:refer user_no="…">Name</band:refer>`.

## Writes

Testing on a private test band on 2026-11-24 verified these from BAND's UI, the bundle, and the server's approval flow. Some writes use GET.

| Action | Endpoint | Parameters |
|---|---|---|
| New post | `POST v2.0.2/create_post` | `band_no`, `content`, `set_band_notice=false`, `set_major_band_notice=false`, `set_linked_band_notice=`, `copiable_state=`, `should_disable_comment=false`, `band_notice_unset_at=`, `purpose=create`. Other values return `result_code` 200. |
| Edit post | `POST v2.0.2/update_post` | `band_no`, `post_no`, `content`, `set_linked_band_notice=`, `copiable_state`, `should_disable_comment`, `notice_state`, `band_notice_unset_at=`. Send `notice` or `off` for `notice_state`, because editing resets the notice. |
| Read one post | `GET v2.0.0/get_post` | `band_no`, `post_no`, `resolution_type=4` |
| Add notice | `GET v2.0.1/set_band_notice_state` | `band_no`, `post_no`, `state=notice`, `unset_at=`, `time_zone_id` |
| Remove notice | `GET v2.0.1/set_band_notice_state` | `band_no`, `post_no`, `state=off`, `set_linked_band_notice=false` |
| Comment or reply | `POST v2.3.0/create_comment` | `band_no`, `member_type=membership`, `body`, `photos=`, `file=`, `video=`, `content_key`, `is_secret=false`, `resolution_type=4`. Use comment-read `content_key` formats, with `post_comment` or `schedule_comment` for replies. |
| Delete comment | `GET v2.0.0/delete_comment` | `band_no`, `content_key` `{"content_type":"post_comment","post_no":N,"comment_id":C}`. Reply deletion keys are unknown. |
| Delete post | `GET v1.5.0/delete_post` | `band_no`, `post_no`, `version=20140508` |
| Edit comment | `POST v2.3.0/update_comment` | Seen in the bundle, not tested. |

BAND stores text HTML-escaped for `&lt;`, `&gt;`, and `&amp;` and displays it unescaped, so the server escapes outgoing text. Mentions use `<band:refer user_no="N">Name</band:refer>`. `get_members_of_band_with_filter` omits the signed-in user.

Chat messages are not mapped because BAND chat does not use this API. The server refuses post edits with attachments until edit attachment fields are known.

Testing on the test band on 2026-11-26 mapped photo and video uploads in `src/media.ts`:

- **Upload flow.** Uploads post multipart data to `POST https://usw-up.band.us/v3/upload_photo` or `/v3/upload_video` with `scan=false`, `bandNo`, `attachment` for the file, and `_attachment` for the file name. Post videos also send `mute=false`. BAND signs uploads with `akey` and `md`, so the server uses `input._mediaUploadInput` in a separate tab. It passes Chrome the local path with DevTools `DOM.setFileInputFiles`, since Playwright's `setInputFiles` rejects files over 50 megabytes over CDP, and reads `result_data` `{id, url, width, height}`. Videos add `size` and `playtime`, with `url` as the poster JPEG. Load one file per page because a comment box with a photo rejects a video.
- **Post payload.** `create_post` `content` ends with `<band:attachment type="photo|video" id="c1" />` tags. `photo` is JSON `{"c1": {url, width, height}}`, and `video` is JSON `{"c2": {id, url, width, height, title, is_gif: false, live_id: "", is_soundless: false}}`. BAND replaces the tag ids with its own.
- **Comment payload.** `create_comment` `photos` is a JSON array `[{url, width, height}]`, and `video` is JSON `{id, url, width, height, title, is_gif: false}`. A comment accepts several photos or one video, not both.
