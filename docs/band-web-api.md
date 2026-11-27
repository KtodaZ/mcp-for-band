# BAND web API (as used by the BAND MCP)

What this server calls, learned from BAND's own web app on 2026-11-24. Undocumented and subject to change. No member content here.

## How requests are made

BAND's web app (`www.band.us`) is a webpack 4 bundle. Its API client class (module 283 on 2026-11-24; found by shape, a constructor with `send` and `__send` on its prototype) adds the `akey` and `md` headers and the `language` and `DEVICE-TIME-ZONE-*` headers, and refreshes the session before sending. The global `jQuery.ajax` doesn't sign, and BAND answers unsigned requests with `result_code` 300.

`band.ts` adds an init script that captures webpack's `require` on page load (it wraps `Function.prototype.call` until the first module factory runs, then restores it), finds the client class, and creates `new Client({ bandApi: true })`. `call(endpoint, data, method)` then runs `client.send({ url: "https://api.band.us/<endpoint>", data, method })` in the page. The client rewrites `api.band.us` to the regional host (`api-usw.band.us`). One request takes a few hundred milliseconds. Requests are queued, one at a time, at least 300 ms apart.

Every response has `result_code` (1 = OK) and `result_data`. Seen errors: 200 (bad parameters), 300 (unsigned), 1003 (rate limited), 2 or 401 (signed out). Every endpoint the MCP calls or sees is recorded, parameter names only, in `endpoints.json` in the data folder.

## Reads

| Endpoint | Parameters | Returns |
|---|---|---|
| `POST v2.3.0/get_band_list` | none | `items[]` of `{ band: { band_no, name, member_count, … }, member }`, `pinned_band_nos` |
| `GET v2.0.0/get_posts_and_announcements` | `band_no`, `order_by=created_at_desc`, `resolution_type=4`, `limit` (20) | `items[].post` (`post_no`, `content`, `author`, `created_at` ms, `comment_count`, `emotion_count`, `read_count`, `photo_count`, `video_count`, `is_notice`, `is_major_notice`, `web_url`, `attachment`, `latest_comment`, `featured_comment`). Next page: pass `paging.next_params` back as the whole parameter set (`after_post_no`, `after_announcement_created_at`, …) |
| `GET v2.3.0/get_comments` | `band_no`, `content_key` (JSON string), `resolution_type=4` | `items[]` (`comment_id`, `body`, `author`, `created_at`, `comment_count` = replies, `emotion_count`, photos), `total` (comments plus replies), `paging.previous_params` for older comments (null when all are in) |
| `GET v1.6.0/get_schedules` | `band_no`, `start_at` and `future_end_at` as `YYYYMMDD`, `calendars=null` | `items[]` (`schedule_id`, `name`, `description`, `start_at`, `end_at`, `location`, `comment_count`, `is_delete`, `calendar`, …), `paging.next_params` |
| `GET v2.0.0/get_band_notices` | `band_no`, `limit` | `items[]` (`post_no`, `title`, `is_major`, `notice_created_at`, `post_created_at`, `author`, `read_count`) |
| `GET v2.0.0/get_members_of_band_with_filter` | `band_no`, `filter=` (empty) | `members[]` (`user_no`, `name`, `profile_image_url`), `member_count`. `filter=all` or `member` is rejected |
| `GET v1.6.0/get_upcoming_schedules` | `band_no`, `limit` | upcoming events |

`content_key` values:

- Post comments: `{"content_type":"post","post_no":N}`
- Replies to a post comment: `{"content_type":"post_comment","post_no":N,"comment_id":C}`
- Event comments: `{"content_type":"schedule","schedule_id":"4/<band>/<id>/<date>"}`
- Replies to an event comment: `{"content_type":"schedule_comment","schedule_id":"…","comment_id":C}`

Schedule ids starting `5/` are BAND's public-holiday calendar. Mentions in text are `<band:refer user_no="…">Name</band:refer>`.

## Writes

Verified on a private test band on 2026-11-24, from BAND's own UI requests and the bundle's request code, then end to end through the MCP's approval flow. Some writes are GET requests.

| Action | Endpoint | Parameters |
|---|---|---|
| New post | `POST v2.0.2/create_post` | `band_no`, `content`, `set_band_notice=false`, `set_major_band_notice=false`, `set_linked_band_notice=`, `copiable_state=`, `should_disable_comment=false`, `band_notice_unset_at=`, `purpose=create` (other values give `result_code` 200) |
| Edit post | `POST v2.0.2/update_post` | `band_no`, `post_no`, `content`, `set_linked_band_notice=`, `copiable_state`, `should_disable_comment`, `notice_state` (`notice` or `off`: an edit resets the notice, so send the current state), `band_notice_unset_at=` |
| Read one post | `GET v2.0.0/get_post` | `band_no`, `post_no`, `resolution_type=4` |
| Add notice | `GET v2.0.1/set_band_notice_state` | `band_no`, `post_no`, `state=notice`, `unset_at=`, `time_zone_id` |
| Remove notice | `GET v2.0.1/set_band_notice_state` | `band_no`, `post_no`, `state=off`, `set_linked_band_notice=false` |
| Comment or reply | `POST v2.3.0/create_comment` | `band_no`, `member_type=membership`, `body`, `photos=`, `file=`, `video=`, `content_key` (as for reading comments; a reply uses the `post_comment` or `schedule_comment` key), `is_secret=false`, `resolution_type=4` |
| Delete comment | `GET v2.0.0/delete_comment` | `band_no`, `content_key` `{"content_type":"post_comment","post_no":N,"comment_id":C}`. The key for deleting a reply isn't known |
| Delete post | `GET v1.5.0/delete_post` | `band_no`, `post_no`, `version=20140508` |
| Edit comment | `POST v2.3.0/update_comment` | seen in the bundle, not tested |

Text is stored HTML-escaped (`&lt;`, `&gt;`, `&amp;`) and BAND shows it unescaped, so the MCP escapes what it sends. A mention is `<band:refer user_no="N">Name</band:refer>` in the text. The member list (`get_members_of_band_with_filter`) leaves out the signed-in user.

Not mapped: chat messages (BAND chat doesn't send through this API). Editing a post that has attachments is refused until the edit request's attachment fields are known.

Photos and videos (mapped 2026-11-26 on the test band; `src/media.ts`):

- **Upload:** `POST https://usw-up.band.us/v3/upload_photo` or `/v3/upload_video`, multipart `scan=false`, `bandNo`, `attachment` (the file), `_attachment` (file name); a post's video upload also sends `mute=false`. BAND signs it (`akey`, `md`), so the MCP uploads through the comment box's `input._mediaUploadInput` in its own tab. It hands Chrome the local path with DevTools `DOM.setFileInputFiles` (Playwright's `setInputFiles` refuses files over 50 MB over CDP) and reads the response: `result_data` `{id, url, width, height}`; videos add `size` and `playtime`, and their `url` is the poster JPEG. One file per page load: a comment box holding a photo won't take a video.
- **Post:** `create_post` `content` ends with `<band:attachment type="photo|video" id="c1" />` tags; `photo` is JSON `{"c1": {url, width, height}}` and `video` is JSON `{"c2": {id, url, width, height, title, is_gif: false, live_id: "", is_soundless: false}}`. BAND rewrites the tag ids to its own.
- **Comment:** `create_comment` `photos` is a JSON array `[{url, width, height}]`; `video` is JSON `{id, url, width, height, title, is_gif: false}`. Several photos or one video, not both.
