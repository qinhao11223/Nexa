# -*- coding: utf-8 -*-
# 这里是 Nexa 未来的 AI 后端引擎（大厨）
# 这个文件不被 Electron 直接运行，而是当用户需要本地算力时，由 Electron 唤醒。

def main():
    print("Nexa Python 引擎已启动...")
    # 后期在这里接入 FastAPI 或 Flask 接收前端发来的指令
    # 或者是直接执行复杂的本地生图/视频脚本

if __name__ == "__main__":
    main()
