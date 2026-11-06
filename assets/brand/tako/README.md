# TAKO Logo

采用用户选定的第一方向：圆润的章鱼印记、竖向双眼和稳定的腕部轮廓。

| 文件 | 用途 | 尺寸 |
| --- | --- | --- |
| [tako-mark.png](../../../ui/assets/tako-mark.png) | 透明底独立标志 | 1254 × 1254 |
| [tako-icon.png](../../../ui/assets/tako-icon.png) | favicon、应用与插件图标 | 1254 × 1254 |
| [tako-lockup-ink.png](../../../ui/assets/tako-lockup-ink.png) | 浅色背景横版字标 | 2172 × 724 |
| [tako-lockup-white.png](../../../ui/assets/tako-lockup-white.png) | 深色背景单色字标 | 2172 × 724 |

[实际背景与尺寸校样](logo-proof.png)展示浅色、深色背景及 16、24、32、48px 的浏览器渲染。[所选方向](selected-direction.png)保留原始选择依据。

## 使用

保持原始比例，四周至少保留一个眼孔高度的空白。小尺寸仅使用独立标志或应用图标。浅色背景使用 ink 横版，深色背景使用 white 横版；不拉伸、不加描边或投影，不裁掉腕部。

产品主色目标值沿用 `#6D4AFF`，控件仍以设计变量为准。素材通过内置 ImageGen 生成，PNG 可有轻微色值和透明边缘变化；本轮没有提供可编辑 SVG 母版，也没有用 PNG 冒充矢量。

源 PNG 保存在 ui/assets。Dashboard 将标志与 favicon 作为 data URL 打包，不依赖旧服务新增图片路由。插件构建将同一份应用图标复制到两个 adapter 的 assets 目录，Codex manifest 使用已有的 composerIcon / logo 字段。README 通过 picture 切换深浅背景字标。

[生成方式、再现简报与文件校验值](prompts.json)。未采用下载素材包的 SVG。
