# 卡号追踪网站

这是一个手机和电脑都能用的 dealer 卡号追踪网页。可以添加、搜索、编辑和删除这些资料：

- Dealer 名字
- 卡号
- 包裹公司
- 尾号码
- 状态
- 开保日期
- 备注

网站分成两个页面：

- `index.html` 是 Dealer 名单。
- `dealer.html` 是单个 Dealer 的专属资料页。

在 Dealer 名单添加或点开 `Dealer 1` 后，会进入 `Dealer 1` 自己的页面，里面只管理他的资料，不会和其他 Dealer 混在一起。

Dealer 名字会一直留在名单里，就算他的记录删完也不会自动消失。只有在 Dealer 名单页按“删除”并确认，才会删除这个 Dealer 和他的全部记录。

状态选项可以自己新增和删除。进入任意 Dealer 资料页，在“新增状态选项”输入新的状态名称并添加，之后所有记录的状态下拉框都会出现这个选项。删除状态选项后，已经使用这个状态的旧记录会保留原状态，避免资料变空。新增的状态、删除状态和开保日期都会跟着 Firebase 一起同步。

包裹公司已经改成下拉选择，预设放入马来西亚常见快递和电商物流公司，例如 Pos Laju、J&T Express、DHL、Ninja Van、GDEX、City-Link、Flash Express、SPX Express、Skynet、ABX、KEX、BEST、Aramex、FedEx、UPS 等。

## 马上试用

直接打开 `index.html` 就能使用。未设置同步时，资料会先保存在当前这台设备的浏览器里。

## 开启多人同步

这个网页已经接好 Firebase Realtime Database。设置好之后，所有人打开同一个网站都能实时查看和修改。

更详细的同步设置看 `SYNC_SETUP.md`。

1. 到 Firebase 建一个项目。
2. 开启 Realtime Database。
3. 在项目设置里复制 Web App 的 Firebase config。
4. 打开 `firebase-config.js`，把里面的空值换成你的 config。
5. 把整个文件夹上传到 Netlify、Vercel、Firebase Hosting 或任何静态网站空间。

测试用的 Realtime Database rules 可以先这样设：

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

公开写入代表任何知道网址的人都可以查看和修改。正式使用时，建议再加登录权限，避免资料被陌生人改动。
