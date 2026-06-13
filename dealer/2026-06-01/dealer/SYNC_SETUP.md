# 同步设置

这个网站已经接好 Firebase Realtime Database。要真正多人同步，需要把你的 Firebase Web App config 填到 `firebase-config.js`。

## 需要你提供的资料

在 Firebase 项目设置里复制 Web App config，格式像这样：

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  databaseURL: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

把这些值填进 `firebase-config.js` 之后，上传网站，所有人打开同一个网址就会实时同步。

## 数据库规则

目前 `database.rules.json` 是公开读写，适合先测试：

```json
{
  "rules": {
    "dealer-card-tracker": {
      ".read": true,
      ".write": true
    }
  }
}
```

正式使用时建议加登录权限，避免陌生人乱改资料。
