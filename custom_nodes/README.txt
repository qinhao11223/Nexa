Nexa 画布 - 自定义节点库

这个文件夹用于存放你的自定义节点。你可以在外部自由整理子文件夹结构。

扫描规则（当前版本）：
- Nexa 会递归扫描 custom_nodes 下的所有 node.json 文件
- 每个 node.json 代表一个节点清单（manifest）

最小字段要求（缺失会被忽略）：
- schema_version: "1.0"
- node_id: 字符串（全局唯一）
- version: 字符串
- display_name: 字符串（显示名）
- interface.inputs: 数组
- interface.outputs: 数组

提示：
- 目前仅用于“节点库展示/搜索/放置到画布”。执行（Runner）会在后续版本接入。
