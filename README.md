# TeleBox-Next-Plugins

Theo's custom plugin collection for [TeleBox-Next](https://github.com/TeleBoxOrg/TeleBox-Next), organized in the same one-directory-per-plugin layout as the official plugin repository.

Classic TeleBox versions are maintained separately in [s-theo/TeleBox-Plugins](https://github.com/s-theo/TeleBox-Plugins).

## Plugins

- `aix`: AI assistant with chat, search, image, video and Telegraph features.
- `cd2`: CloudDrive2 管理：账户安全、Token 生命周期、文件/挂载点、传输任务、官方远程上传、Cloud API、备份策略、WebDAV、离线任务和系统服务控制。
- `dme`: delete personal messages with anti-recall media replacement.
- `save_sticker`: save stickers and images to personal sticker sets with batch collection.
- `sink`: manage Sink short links.
- `t`: text-to-speech powered by edge-tts and ffmpeg.
- `yvlu`: generate quote stickers and manage a personal sticker set.

## cd2 setup

帮助入口：`.h cd2`。直接输入 `.cd2` 不会显示帮助；`.cd2 h` 不是帮助命令。

当前已接入的命令和用途：

### 账户与安全

- `.cd2 collapse`：查看 Telegram 原生折叠状态；`.cd2 collapse on` 开启，`.cd2 collapse off` 关闭。`.h cd2` 会按当前设置显示或关闭原生折叠。
- `.cd2 conf show`：查看当前配置，服务地址、账户、Token、默认路径和 WebDAV 配置中的敏感值会自动脱敏。
- `.cd2 conf endpoint 地址`：设置 CloudDrive2 服务地址。
- `.cd2 conf account 用户名 密码`：保存 CloudDrive2 账户用户名和密码，并清除旧 API Token。
- `.cd2 conf token API令牌`：保存 API Token，后续 CloudDrive2 请求优先使用该 Token。
- `.cd2 conf path 默认路径`：设置文件浏览、上传、下载和任务命令使用的默认路径。
- `.cd2 conf dav-url WebDAV地址`：设置 WebDAV 服务地址。
- `.cd2 conf dav-user 用户名 密码`：设置 WebDAV 用户名和密码；未单独配置时可使用 CloudDrive2 账户。
- `.cd2 conf dav-root 上传根目录`：设置 Telegram 文件通过 WebDAV 上传时使用的根目录。
- `.cd2 account logout`：退出 CloudDrive2，并清除本地登录 Token。
- `.cd2 account reset-email` / `.cd2 account reset`：发送密码重置邮件或执行密码重置。
- `.cd2 account delete-email` / `.cd2 account delete DELETE_CODE PASSWORD [TOTP] [forfeit] confirm`：发送账户注销邮件，并在确认后注销账户。
- `.cd2 2fa status|setup|enable|disable`：查看、设置、启用或关闭两步验证。
- `.cd2 2fa recovery|regenerate`：查看或重新生成恢复码；`login` 使用 TOTP 登录。
- `.cd2 session list|revoke|revoke-others`：查看会话、撤销指定会话或撤销其他会话。
- `.cd2 token show|list|info|create|modify|remove`：查看、创建、修改和删除 API Token；Token 展示会脱敏。

### 文件、挂载和传输

- `.cd2 ls|find|grep`：浏览目录、按名称搜索文件、搜索文件内容。
- `.cd2 mkdir|rename|mv|cp|rm`：创建目录、改名、移动、复制和删除文件。
- `.cd2 df`：查看空间使用情况；`.cd2 file detail|meta|original`：查看文件详情、元数据和原始路径。
- `.cd2 dl /路径/文件`：下载 CloudDrive2 文件并替换当前命令消息，不生成公开下载链接。
- `.cd2 transfer status|downloads|uploads`：查看任务总量和下载/上传进度。
- `.cd2 transfer copies|merges`：查看复制/移动任务和合并任务。
- `.cd2 transfer pause|resume|cancel`：控制下载/上传任务。
- `.cd2 transfer copy pause|resume|cancel|restart SOURCE DEST`：暂停、恢复、取消或重启指定复制任务。
- `.cd2 transfer copy pause-all|resume-all|remove-completed|remove-all`：批量暂停、恢复或清理复制任务。
- `.cd2 transfer copy pause|resume|remove TASK_KEY`：按任务键控制或删除复制任务。
- `.cd2 transfer merge cancel SOURCE DEST`：取消指定合并任务。
- `.cd2 mount list`：列出挂载点；`.cd2 mount can-add`：检查是否还能添加挂载点。
- `.cd2 mount add|update|mount|unmount|remove`：新增、修改、挂载、卸载或删除挂载点。

### Cloud API

- `.cd2 api list`：列出已配置的云盘；`remove` 删除云盘配置。
- `.cd2 api add`：添加 WebDAV、本地目录、PikPak、115、阿里、百度、OneDrive、Google、迅雷、123 云盘、光鸭云盘和 CloudDrive。
- `.cd2 api add s3|sftp|ftp|smb`：添加 S3、SFTP、FTP/FTPS 或 SMB 存储。
- `.cd2 api config get|set`：查看或修改线程数、限速、代理、TLS 和下载选项。
- `.cd2 api discover-smb` / `.cd2 api discover-smb-shares`：发现 SMB 服务器及其共享目录。
- OAuth/二维码登录：用于 115 Open、123 云盘、光鸭云盘、迅雷 Open、115、阿里云盘和 189 云盘等服务。

### 备份

- `.cd2 backup list|status`：查看备份列表、状态、目标、规则和计划。
- `.cd2 backup add|update|remove`：新增、更新和删除备份任务。
- `.cd2 backup enable|watch`：开关备份任务和文件系统监听；`destination` 管理备份目标。
- `.cd2 backup strategy`：设置文件替换、删除、完成策略和扫描间隔。
- `.cd2 backup schedule add|clear`：添加或清空按时间/星期执行的计划。
- `.cd2 backup rule add|clear`：设置扩展名、文件名、正则、大小及黑白名单规则。
- `.cd2 backup restart`：立即重新扫描；`can-add` 查询是否还能添加备份。

### 远程上传、离线任务和系统

- 回复 Telegram 文件后使用 `.cd2 remote upload /目标目录`：通过 CloudDrive2 官方远程上传协议上传。
- `.cd2 remote control pause|resume|cancel`：控制远程上传。
- `.cd2 remote add|list|list-all|remove`：创建、查看和删除网盘离线下载任务。
- `.cd2 remote quota|clear|restart`：查询离线配额、清理离线任务、重启失败任务。
- `.cd2 system runtime|settings|set`：查看运行信息、系统设置和修改单项设置。
- `.cd2 system set-log` / `.cd2 system set-backup-limits`：整体修改日志轮换和备份资源限制。
- `.cd2 system cache stats|list`：查看缓存统计和缓存目录；`.cd2 system cache purge`：清理缓存。
- `.cd2 system cache eviction|folder`：设置淘汰策略或目录缓存规则。
- `.cd2 system dir-cache set|effective|expire|vacuum|size`：设置/查看目录缓存 TTL、强制过期、压缩数据库或查看大小。
- `.cd2 system table open|dir|refs|temp`：查看打开文件表、目录缓存、引用路径和临时文件。
- `.cd2 system web get|set|self-cert`：查看/修改 Web 服务配置或生成自签名证书。
- `.cd2 system service restart|shutdown|update confirm`：重启、关闭或更新服务。
- `.cd2 dav status|on|off`：查看或开关 WebDAV 服务；`.cd2 dav account on|off`：开关账户模式。
- `.cd2 dav ls|mkdir|rm`：浏览、创建或删除 WebDAV 路径。
- `.cd2 dav add|remove`：添加或删除独立 WebDAV 用户。

Cloud API 的二维码登录会返回登录状态消息；OAuth、Cookie、账号密码等敏感值只作为命令参数发送，不会写入插件配置。具体参数格式请使用 `.h cd2` 查看对应命令说明。

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
