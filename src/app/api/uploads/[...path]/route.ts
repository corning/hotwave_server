import { NextRequest, NextResponse } from 'next/server';
import { readFile, stat } from 'fs/promises';
import path from 'path';

const UPLOADS_DIR = path.join(process.cwd(), 'public', 'uploads');

const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
};

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  try {
    const filePath = params.path.join('/');
    const absolutePath = path.resolve(UPLOADS_DIR, filePath);

    // 防止路径遍历攻击（注意不能只用 startsWith：'../uploads-evil' 也会命中前缀）
    const relative = path.relative(UPLOADS_DIR, absolutePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return NextResponse.json({ message: '禁止访问' }, { status: 403 });
    }

    // 检查文件是否存在
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      return NextResponse.json({ message: '不是文件' }, { status: 400 });
    }

    // 读取文件
    const buffer = await readFile(absolutePath);
    const ext = path.extname(absolutePath).toLowerCase();
    const contentType = EXT_TO_MIME[ext] || 'application/octet-stream';

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': buffer.length.toString(),
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'Last-Modified': fileStat.mtime.toUTCString(),
      },
    });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return NextResponse.json({ message: '文件不存在' }, { status: 404 });
    }
    return NextResponse.json({ message: '服务器异常' }, { status: 500 });
  }
}
