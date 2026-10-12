# 符号授权标注 · 拾言 ReVoice

本项目患者端界面所使用的象形符号，全部来自 **ARASAAC**（ARASAAC pictographic symbols），未自绘。

## 必须保留的标注文本（直接复制到仓库 README 与 PPT 备查页）

> 本项目界面使用的象形符号来自 **ARASAAC**（https://arasaac.org），
> 作者 **Sergio Palao**，版权所有者 **西班牙阿拉贡政府（Government of Aragon, Spain）**，
> 采用 **CC BY-NC-SA** 许可协议发布。

英文版（提交 Gitee / GitHub 仓库时建议用这一版）：

> The pictographic symbols used in this project are from **ARASAAC**
> (https://arasaac.org), authored by **Sergio Palao**, owned by the
> **Government of Aragon (Spain)**, and licensed under **CC BY-NC-SA**.

## 三条使用纪律

1. **非商业（NC）**：参赛、开源、学术展示均合规；**一旦项目涉及商业化，本套符号必须全部替换**为自有或已购商用授权的符号。
2. **相同方式共享（SA）**：若对符号本身做了修改（改色、重绘、裁剪重组），衍生作品仍需以 CC BY-NC-SA 发布。
3. **署名（BY）**：不得省略作者与来源。仅写「图片来源于网络」不满足署名要求。

## 已采用符号清单（10 个）

| 界面标签 | ARASAAC 编码 | 检索词 | 用途 |
|---|---|---|---|
| 喝水 | 37207 | 喝水 | 表达台网格 |
| 吃饭 | 38413 | 吃饭 | 表达台网格 |
| 疼 | 2367 | 疼痛 | 表达台网格（演示句使用） |
| 想上厕所 | 2430 | 马桶 | 表达台网格 |
| 冷 | 7128 | 冰 | 表达台网格 |
| 热 | 35561 | 热 | 表达台网格 |
| 开窗 | 2611 | 窗户 | 表达台网格 |
| 打电话 | 25269 | 手机 | 表达台网格 |
| 吃药 | 3006 | 胶囊 | 表达台网格（演示句使用） |
| 睡觉 | 6479 | 睡觉 | 备用位，未上屏 |

完整字段（含尺寸）见同目录 `manifest.json`。

## 检索方式（可复现）

- 中文检索：`https://api.arasaac.org/api/pictograms/zh/search/<检索词>`
- 取图：`https://static.arasaac.org/pictograms/<id>/<id>_300.png`

> 注意：ARASAAC 中文索引存在空缺，部分常用词（如「冷」「吃药」「接电话」）直接检索会返回 404，
> 需换成近义词（冰 / 胶囊 / 手机）才能命中。
