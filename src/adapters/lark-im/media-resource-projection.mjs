// @ts-check
import { makeMediaResourceBinding, readMediaResource, resourceStorePath } from './media-resource-store.mjs';
import { projectionAccount } from './message-projection-evidence.mjs';
import { isHistoryCommandBudget } from '../../maintenance/history-command-budget.mjs';

/** Add only independently revalidated local bytes to a pure source projection.
 * @param {string} db @param {string|undefined} resourceDir
 * @param {Record<string,any>} row @param {Record<string,any>} canonical
 * @param {Record<string,any>} raw
 * @param {import('./media-content.mjs').MediaProjection|null} media
 * @param {{executionBudget?:ReturnType<typeof import('../../maintenance/history-command-budget.mjs').createHistoryCommandBudget>}} [deps]
 * @returns {import('./media-content.mjs').MediaProjection|null} */
export function projectMediaResource(db,resourceDir,row,canonical,raw,media,deps={}) {
  const budget=deps.executionBudget;
  if(budget!==undefined&&!isHistoryCommandBudget(budget))throw new TypeError('invalid media projection budget');
  budget?.assertReady();
  if(!media || media.type!=='image' || media.resource.state!=='reference_only')return media;
  const account=projectionAccount(row,canonical,raw);
  if(account.state!=='verified')return media;
  const binding=makeMediaResourceBinding(db,row,account.account_key,media);
  if(!binding)return media;
  const resource=readMediaResource(resourceStorePath(db,resourceDir),binding,{executionBudget:budget});
  budget?.assertReady();
  if(resource.status!=='available')return resource.status==='invalid'
    ? {...media,text:'[图片] 本地资源未通过验证',reason:'media_resource_invalid',
      resource:{...media.resource,availability:'invalid',verification_reason:resource.reason}}
    : media;
  return {...media,status:'rendered',reason:null,text:'[图片] 本地资源已验证（未生成文字描述）',
    resource:{...media.resource,...resource,state:'available',availability:'available'}};
}
