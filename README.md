# GloryOfKings-Plugin

<div align="center">

![动态访问量](https://count.kjchmc.cn/get/@GloryOfKings-Plugin?theme=rule34)

一个为 [Yunzai-Bot V3](https://gitee.com/Le-niao/Yunzai-Bot) 提供王者荣耀相关功能的插件

</div>

> [!NOTE]
> 本仓库是 [@Tloml-Starry/GloryOfKings-Plugin](https://gitee.com/Tloml-Starry/GloryOfKings-Plugin) 的 Fork，在原插件基础上新增了 **皮肤墙**（`#皮肤墙`）功能。
> 皮肤墙的营地接口调用逻辑参考自 [@KimigaiiWuyi/WzryUID](https://github.com/KimigaiiWuyi/WzryUID)。
> 感谢原作者们的开源工作，原插件版权与协议归 [@Tloml-Starry](https://gitee.com/Tloml-Starry) 所有。


## 🌟 主要功能

- 🎮 **账号管理**
  - 绑定/切换/删除营地ID
  - 多账号管理支持
  - 账号信息展示

- 📊 **数据查询**
  - 战绩查询(最近30场)
  - 战绩详情(评分/经济/装备等)
  - 英雄战力查询
  - 英雄皮肤查询
  - 游戏概览(段位/场次/MVP等)

## 📦 安装方法

1. 在 Yunzai-Bot 根目录下执行:
```bash
git clone https://gitee.com/Tloml-Starry/GloryOfKings-Plugin.git ./plugins/GloryOfKings-Plugin/
```

2. 安装依赖:
```bash
pnpm install
```

3. 重启 Bot 即可使用

## 🎯 使用指南

### 账号管理
- `#绑定营地 [ID]` - 绑定营地ID,可绑定多个
- `#切换营地 [序号]` - 切换使用的营地ID
- `#删除营地 [序号]` - 删除绑定的营地ID
- `#我的ID` - 查看已绑定的营地ID列表
- `#营地wx登录` - 扫码登录营地，自动保存登录态并绑定当前营地ID
- `#王者用户统计` - 查看当前绑定与使用情况（主人命令）

### 数据查询
- `#王者主页` - 查看游戏信息概览
- `#查询战绩` - 查看最近30场战绩
- `#查询战绩 [序号]` - 查看指定场次详细数据
- `#查战力 [英雄名]` - 查询指定英雄的战力排名
- `#查皮肤 [英雄名]` - 查询指定英雄的皮肤
- `#皮肤墙 [营地ID]` - 查询账号拥有的全部皮肤（皮肤多时自动分页合并转发）

### 系统设置
- `#王者帮助` - 显示功能帮助
- `#王者更新` - 更新插件
- `#王者设置` - 王者插件一些配置项


## ⭐ 支持项目

如果你觉得这个项目对你有帮助,欢迎给一个 Star 支持一下~
