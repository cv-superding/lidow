import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { isAbsoluteProjectPath, isPathInside } from '../src/shared/path'

describe('项目路径校验', () => {
  it('接受 Windows 盘符与 UNC 路径', () => {
    expect(isAbsoluteProjectPath('C:\\Users\\demo\\project', 'win32')).toBe(true)
    expect(isAbsoluteProjectPath('D:/work/project', 'win32')).toBe(true)
    expect(isAbsoluteProjectPath('\\\\nas\\share\\project', 'win32')).toBe(true)
    expect(isAbsoluteProjectPath('relative\\project', 'win32')).toBe(false)
  })

  it('接受 macOS/Linux 绝对路径', () => {
    expect(isAbsoluteProjectPath('/workspace', 'posix')).toBe(true)
    expect(isAbsoluteProjectPath('/Users/demo/project', 'posix')).toBe(true)
    expect(isAbsoluteProjectPath('C:\\Users\\demo', 'posix')).toBe(false)
    expect(isAbsoluteProjectPath('relative/project', 'posix')).toBe(false)
  })

  it('拒绝空值与历史脏值', () => {
    expect(isAbsoluteProjectPath('', 'posix')).toBe(false)
    expect(isAbsoluteProjectPath('undefined', 'win32')).toBe(false)
    expect(isAbsoluteProjectPath('null', 'posix')).toBe(false)
  })
})

describe('isPathInside', () => {
  it('根目录及其子路径算内部', () => {
    const root = resolve('/tmp/lidow-project')
    expect(isPathInside(root, root)).toBe(true)
    expect(isPathInside(root, resolve(root, 'src/index.ts'))).toBe(true)
  })
  it('同名前缀的兄弟目录不算内部（回归：startsWith 前缀绕过）', () => {
    const root = resolve('/tmp/lidow-project')
    expect(isPathInside(root, resolve('/tmp/lidow-project-evil'))).toBe(false)
  })
  it('.. 逃逸不算内部', () => {
    const root = resolve('/tmp/lidow-project')
    expect(isPathInside(root, resolve(root, '../outside'))).toBe(false)
  })
})
