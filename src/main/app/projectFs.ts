import { existsSync, statSync } from 'node:fs'

/**
 * 项目根目录是否仍然存在且是文件夹。
 * 任何 IO 异常（盘符离线、权限不足、路径变成文件）都按「不可用」处理，
 * 绝不能据此 mkdir 把用户删掉的目录重新建出来。
 */
export function isProjectRootAvailable(root: string | null | undefined): boolean {
  if (!root) return false
  try {
    return existsSync(root) && statSync(root).isDirectory()
  } catch {
    return false
  }
}
