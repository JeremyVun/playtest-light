import type { Browser, Page, PageOptions } from '../types.ts';
import { Connection } from './cdp.ts';
import { openPage } from './page.ts';

export async function connectBrowser(wsUrl: string): Promise<Browser> {
  const connection = await Connection.open(wsUrl);
  const { product } = await connection.send<{ product: string }>('Browser.getVersion');
  return {
    version: product.replace(/^.*\//, ''),
    newPage: (opts: PageOptions): Promise<Page> => openPage(connection, opts),
    disconnect: () => connection.close(),
  };
}
