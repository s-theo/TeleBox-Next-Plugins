# TeleBox-Next-Plugins

Theo's custom plugin collection for [TeleBox-Next](https://github.com/TeleBoxOrg/TeleBox-Next), organized in the same one-directory-per-plugin layout as the official plugin repository.

Classic TeleBox versions are maintained separately in [s-theo/TeleBox-Plugins](https://github.com/s-theo/TeleBox-Plugins).

## Plugins

- `aix`: AI assistant with chat, search, image, video and Telegraph features.
- `cd2`: CloudDrive2 主要功能管理：账户/Token、文件与挂载点、上传下载任务、云 API 登录/配置/删除、基础备份、WebDAV 双认证、离线远程上传、下载链接和 Telegram 文件上传。
- `dme`: delete personal messages with anti-recall media replacement.
- `save_sticker`: save stickers and images to personal sticker sets with batch collection.
- `sink`: manage Sink short links.
- `t`: text-to-speech powered by edge-tts and ffmpeg.
- `yvlu`: generate quote stickers and manage a personal sticker set.

## cd2 setup

当前已接入的主要功能：

1. 公共方法：服务状态、登录状态和系统验证
2. 文件操作：目录浏览、文件查询、搜索、创建目录、移动、复制、删除、下载链接
3. 挂载点：列表、新增、修改、挂载、卸载、删除
4. 传输任务：统计、下载列表、上传列表、暂停、恢复、取消
5. 云 API：WebDAV、本地目录、PikPak、115、阿里云盘、百度网盘、OneDrive、Google Drive、迅雷云的主要添加/登录、配置查看/修改和删除
6. 备份：基础新增、修改、启停、文件监听、目标管理、重新扫描、删除
7. WebDAV：服务开关、CloudDrive 账户模式、独立 WebDAV 用户、目录浏览、创建目录、删除路径
8. 令牌：账户登录获取 Token、Token 查看/清除，或手动配置 API Token
9. 远程上传：离线下载任务新增、列表、分页列表、删除；Telegram 文件上传到 WebDAV

Cloud API 的二维码登录会返回登录状态消息；OAuth、Cookie、账号密码等敏感值只作为命令参数发送，不会写入插件配置。

说明：以上是当前已接入的主要功能，不代表已覆盖 CloudDrive2 1.0.14 官方全部 RPC；复制/合并任务完整管理、流式远程上传、Token 生命周期管理、2FA/会话等功能后续继续补充。

The `cd2` plugin uses CloudDrive2's gRPC API. Configure it in Telegram after loading the plugin:

```text
.cd2 conf endpoint http://host:19798
.cd2 conf account YOUR_CLOUDDRIVE_USERNAME YOUR_CLOUDDRIVE_PASSWORD
.cd2 login
.cd2 check
```

也可以使用已有的 API Token：

```text
.cd2 conf token YOUR_CD2_API_TOKEN
```

WebDAV management and Telegram upload:

```text
.cd2 conf dav-url http://host:19798/dav
.cd2 dav on
.cd2 dav account on /Telegram
.cd2 conf dav-user USER PASSWORD
.cd2 conf dav-root /Telegram
.cd2 dav status
.cd2 dav ls /
.cd2 dav add USER PASSWORD /Telegram
.cd2 dav account off
.cd2 dav remove USER confirm
.cd2 up
```

`.cd2 login` 配置的 CloudDrive 账户可以直接用于 WebDAV；`.cd2 dav account on` 启用账户模式。`.cd2 dav add` 仍然可以添加独立的 WebDAV 用户，两种模式可以同时使用。`.cd2 dav status` 会分别显示账户模式和独立用户；消息使用真实换行显示。

Reply to a Telegram file before sending `.cd2 up [目标目录]`; the file is downloaded through the host Telegram client and uploaded with WebDAV `PUT`. The target argument is always treated as a directory, so both `.cd2 up /GoogleDrive` and `.cd2 up /GoogleDrive/` are valid. If Telegram does not provide a filename, the plugin adds an extension from the media type, such as `.jpg` for a photo.

Use `.cd2 dl /路径/文件` to download a file from CloudDrive2 and replace the current command message with the downloaded file. Paths containing spaces are supported without quoting. Linux-style commands such as `ls`, `find`, `grep`, `mkdir`, `mv`, `cp`, `rm`, `df`, and `mount` are used where appropriate.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run format:check
```
