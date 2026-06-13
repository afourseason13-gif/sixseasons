# Telegram 自动导入设置

不要把 Bot Token 写进网页代码。Token 要放在 Firebase Functions Secret。

## 1. 重新生成 Token

你刚才贴出来的 Token 建议在 BotFather 重新生成一次。

BotFather:

```txt
/mybots
选择你的 bot
API Token
Revoke current token
```

## 2. 关闭 Bot Privacy

让 Bot 可以读取群消息：

```txt
/mybots
选择你的 bot
Bot Settings
Group Privacy
Turn off
```

然后把 Bot 拉进 Telegram 群。

## 3. 设置 Firebase Secret

在项目文件夹运行：

```bash
firebase functions:secrets:set TELEGRAM_BOT_TOKEN
```

粘贴新的 Bot Token。

## 4. 部署 Functions

```bash
firebase deploy --only functions,database
```

部署后 Firebase 会给你一个函数网址，类似：

```txt
https://telegramwebhook-xxxxx.a.run.app
```

## 5. 设置 Telegram Webhook

把下面的网址里的 `<BOT_TOKEN>` 和 `<FUNCTION_URL>` 换掉，然后在浏览器打开：

```txt
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<FUNCTION_URL>
```

之后群里发资料，Bot 会自动写入网站。

## 支持格式

建议群消息包含 Dealer：

```txt
Dealer: Dealer 1
```

如果没有 Dealer，会自动放到 `Telegram` 这个 Dealer 里。

完整资料会原样保存到 `标准格式资料`，网站里按 `查看` 可以看到。
