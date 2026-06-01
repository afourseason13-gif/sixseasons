# Render Telegram Bot 设置

这个方式不用 Firebase Blaze。Render 负责跑 Telegram Bot，然后把群消息写进 Firebase Realtime Database。

## 1. 准备新的 Bot Token

你之前贴出来的 Token 建议先去 BotFather 重新生成。

## 2. 准备 Firebase Service Account

Firebase Console:

1. Project settings
2. Service accounts
3. Generate new private key
4. 下载 JSON 文件

打开 JSON 文件，复制完整内容，之后放到 Render 环境变量。

## 3. 上传代码到 GitHub

Render 最容易从 GitHub 部署。把这个文件夹上传到一个 GitHub repo。

## 4. Render 创建 Web Service

Render:

1. New
2. Web Service
3. 选择你的 GitHub repo
4. Root Directory 填：

```txt
render-bot
```

5. Build Command:

```txt
npm install
```

6. Start Command:

```txt
npm start
```

## 5. Render 环境变量

在 Render 的 Environment 填：

```txt
TELEGRAM_BOT_TOKEN=你的新 bot token
FIREBASE_DATABASE_URL=https://project-4759949686691452094-default-rtdb.asia-southeast1.firebasedatabase.app/
FIREBASE_SERVICE_ACCOUNT_JSON=你的 service account JSON 完整内容
```

## 6. 设置 Telegram Webhook

Render 部署完成后会有网址，例如：

```txt
https://你的服务.onrender.com
```

Webhook URL 是：

```txt
https://你的服务.onrender.com/telegram
```

打开这个网址设置 webhook：

```txt
https://api.telegram.org/bot你的新TOKEN/setWebhook?url=https://你的服务.onrender.com/telegram
```

成功后，Telegram 群里发资料，Bot 会自动导入网站。

## 群消息格式

建议加 Dealer：

```txt
Dealer: Dealer 1

*NAMA* :
...
```

如果没有 Dealer，会自动导入到 `Telegram` 这个 Dealer。
