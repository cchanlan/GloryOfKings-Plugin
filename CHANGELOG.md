# 更新日志

## [1.2.0] - 2024-11-16
### 新增
- 新增了 `queryGameRecordDetails` 功能，用户可以查看对局详情

## [1.1.7] - 2024-11-16
### 优化
 - 优化了请求参数，使用 `Web` 可以让Token保存时间更长
 
## [1.1.6] - 2024-11-15
### 优化
- 优化了 `queryGameStats` 增加胜率展示信息

## [1.1.5] - 2024-11-15
### 删除
- 删除了 `bindId` 功能
### 优化
- 优化了 `scanCodeLogin` 的提示信息

## [1.1.4] - 2024-11-15
### 修复
- 修复了 `scanCodeLogin` 的Token有效时间获取出错的问题

## [1.1.3] - 2024-11-15
### 优化
- 优化了 `scanCodeLogin` 合并了获取Token和OpenId的逻辑，并增加了Token有效时间提示

## [1.1.2] - 2024-11-15
### 修复
- 修复了 `myKingHomepage` 信息展示错位的问题
- 修复了 `myKingHomepage.html` 段位图片错位问题

## [1.1.1] - 2024-11-15
### 修复
- 修复了 `myKingHomepage` 无 `value1` 的问题
### 优化
- 优化了 `myKingHomepage.html` 的样式

## [1.1.0] - 2024-11-15
### 优化
- 优化了 `myKingHomepage.html` 的样式
- 更改了 `myKingHomepage` 的请求地址

## [1.0.10] - 2024-11-15
### 优化
- 优化了 `QueryGameStats.html` 的样式

## [1.0.9] - 2024-11-15
### 新增
-  `queryGameStats` 功能增加了游戏时长和对局评分

## [1.0.8] - 2024-11-15
### 新增
- 添加 `getMyTokenAndOpenId` 功能，用户可以通过 `#我的王者Tk` 命令查看自己的Token和OpenId。

## [1.0.7] - 2024-11-14
### 优化
- 优化了 `scanCodeLogin` 扫码登录逻辑和提示信息

## [1.0.6] - 2024-11-14
### 修复
- 修复了 `scanCodeLogin` 存储数据格式问题

## [1.0.5] - 2024-11-14
### 修复
- 修复了 `myKingHomepage` 无导入 `fs` 模块的问题

## [1.0.4] - 2024-11-14
### 修复
- 修复了 `myKingHomepage` 无导入 `path` 模块的问题

## [1.0.3] - 2024-11-14
### 修复
- 修复了 `myKingHomepage` 功能
- 修复了 `queryGameStats` 功能
- 修复了 `scanCodeLogin` 功能

## [1.0.2] - 2024-11-14
### 修复
- 修复了 `myKingHomepage` 功能
- 修复了 `queryGameStats` 功能

## [1.0.1] - 2024-11-14
### 新增
- 添加 `help` 功能，用户可以查看帮助信息。

## [1.0.0] - 2024-11-14
### 新增
- 添加 `bindId` 功能，允许用户绑定营地ID。
- 添加 `myKingHomepage` 功能，用户可以查看自己的王者主页。
- 添加 `queryGameStats` 功能，用户可以查询游戏战绩。
- 添加 `scanCodeLogin` 功能，支持扫码登录。

### 修复
- 修复了在某些情况下无法正确读取用户数据的问题。

### 改进
- 优化了 API 请求的处理逻辑，提高了响应速度。
- 更新了 `README.md` 文件，提供更详细的安装和使用说明。