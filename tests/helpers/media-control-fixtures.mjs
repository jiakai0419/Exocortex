import { deflateSync } from 'node:zlib';

// Every image byte here is authored synthetic data, never a captured resource.
function chunk(type, data) {
  const name=Buffer.from(type), head=Buffer.alloc(4), sum=Buffer.alloc(4);
  let crc=0xffffffff;
  for(const byte of Buffer.concat([name,data])) {crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}
  head.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([head,name,data,sum]);
}
const c=(type,data)=>chunk(type,Buffer.from(data));
function png({color=6,depth=8,palette=color===3?2:0,prePalette=[],before=[],after=[]}={}) {
  const h=Buffer.alloc(13);h.writeUInt32BE(1);h.writeUInt32BE(1,4);h[8]=depth;h[9]=color;
  const channels=({0:1,2:3,3:1,4:2,6:4})[color], pixels=Buffer.alloc(1+Math.ceil(depth*channels/8));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),...prePalette,
    ...(palette?[chunk('PLTE',Buffer.alloc(palette*3))]:[]),...before,chunk('IDAT',deflateSync(pixels)),...after,chunk('IEND',Buffer.alloc(0))]);
}
const baseGif=Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b','hex');
function frame(local=0) {
  const base=Buffer.from(baseGif.subarray(19,-1));
  if(!local)return base;
  base[9]=0x80|(Math.log2(local)-1);
  return Buffer.concat([base.subarray(0,10),Buffer.alloc(3*local),base.subarray(10)]);
}
function gif({width=1,global=2,local=0,background=0,before=[],after=[]}={}) {
  const head=Buffer.from(baseGif.subarray(0,13));head.writeUInt16LE(width,6);
  head[10]=global?0x80|(Math.log2(global)-1):0;head[11]=background;
  return Buffer.concat([head,Buffer.alloc(3*global),...before,frame(local),...after,Buffer.from([0x3b])]);
}
const gce=({disposal=0,transparent=false,index=0,user=false,delay=0}={})=>
  Buffer.from([0x21,0xf9,4,(disposal<<2)|(transparent?1:0)|(user?2:0),delay&255,delay>>8,index,0]);
const comment=Buffer.from([0x21,0xfe,1,65,0]);
const special=Buffer.from([0x21,0xfa,1,77,0]);
const application=Buffer.concat([Buffer.from([0x21,0xff,11]),Buffer.from('SYNTHETC'),Buffer.from([0,255,3,1,7,0])]);
const invalid='resource_image_invalid', unsupported='resource_format_unsupported';

export function mediaControlCases() {
  const cases=[];
  const add=(name,bytes,reason=null)=>cases.push({name,bytes,reason,mime:bytes[0]===0x89?'image/png':'image/gif'});
  add('png_rgba_valid',png());
  add('png_rgba_forbidden_trns',png({before:[c('tRNS',[0,0])]}),invalid);
  add('png_gray_alpha_forbidden_trns',png({color:4,before:[c('tRNS',[0,0])]}),invalid);
  add('png_gray_valid_trns',png({color:0,before:[c('tRNS',[0,0])]}));
  add('png_gray_low_depth_high_bits_are_ignored',png({color:0,depth:1,before:[c('tRNS',[255,255])]}));
  add('png_rgb_valid_trns',png({color:2,before:[c('tRNS',[0,0,0,0,0,0])]}));
  add('png_indexed_valid_trns',png({color:3,before:[c('tRNS',[0])]}));
  add('png_indexed_empty_trns_is_opaque',png({color:3,before:[c('tRNS',[])]}));
  add('png_indexed_trns_overflow',png({color:3,before:[c('tRNS',[0,1,2])]}),invalid);
  add('png_indexed_trns_before_palette',png({color:3,prePalette:[c('tRNS',[0])]}),invalid);
  add('png_gray_wrong_trns_length',png({color:0,before:[c('tRNS',[0])]}),invalid);
  add('png_rgb_wrong_trns_length',png({color:2,before:[c('tRNS',[0,0])]}),invalid);
  add('png_duplicate_trns',png({color:0,before:[c('tRNS',[0,0]),c('tRNS',[0,0])]}),invalid);
  add('png_late_trns',png({color:0,after:[c('tRNS',[0,0])]}),invalid);
  add('png_palette_after_trns',png({color:2,palette:2,prePalette:[c('tRNS',[0,0,0,0,0,0])]}),invalid);
  add('png_background_valid_palette',png({color:3,before:[c('bKGD',[1])]}));
  add('png_background_palette_overflow',png({color:3,before:[c('bKGD',[2])]}),invalid);
  add('png_background_valid_rgba',png({before:[c('bKGD',[0,1,0,2,0,3])]}));
  add('png_background_low_depth_high_bits_are_ignored',png({color:0,depth:1,before:[c('bKGD',[255,255])]}));
  add('png_background_wrong_length',png({before:[c('bKGD',[0,0])]}),invalid);
  add('png_background_before_palette',png({color:3,prePalette:[c('bKGD',[0])]}),invalid);
  add('png_background_duplicate',png({color:3,before:[c('bKGD',[0]),c('bKGD',[1])]}),invalid);
  add('png_background_late',png({color:3,after:[c('bKGD',[0])]}),invalid);
  add('png_histogram_valid',png({color:3,before:[c('hIST',[0,1,0,0])]}));
  add('png_histogram_used_color_declared_unused',png({color:3,before:[c('hIST',[0,0,0,1])]}),invalid);
  add('png_histogram_wrong_length',png({color:3,before:[c('hIST',[0,1])]}),invalid);
  add('png_histogram_without_palette',png({before:[c('hIST',[0,1])]}),invalid);
  add('png_histogram_duplicate',png({color:3,before:[c('hIST',[0,1,0,0]),c('hIST',[0,1,0,0])]}),invalid);
  add('png_histogram_late',png({color:3,after:[c('hIST',[0,1,0,0])]}),invalid);
  add('png_unknown_ancillary_before',png({before:[c('vpAg',[1,2,3])]}));
  add('png_unknown_ancillary_after',png({after:[c('vpAg',[1,2,3])]}));
  const actl=Buffer.alloc(8);actl.writeUInt32BE(2);
  add('png_animation_declares_two_frames_with_no_fctl',png({before:[chunk('acTL',actl)]}),unsupported);
  add('png_standalone_fctl_unsupported',png({before:[c('fcTL',Array(26).fill(0))]}),unsupported);
  add('png_standalone_fdat_unsupported',png({after:[c('fdAT',[0,0,0,0])]}),unsupported);
  const one=Buffer.alloc(8);one.writeUInt32BE(1);const fctl=Buffer.alloc(26);fctl.writeUInt32BE(1,4);fctl.writeUInt32BE(1,8);
  add('png_valid_single_frame_animation_still_unsupported',png({before:[chunk('acTL',one),chunk('fcTL',fctl)]}),unsupported);
  add('gif_control_valid',gif());
  for(let disposal=0;disposal<=3;disposal++)add(`gif_valid_gce_disposal_${disposal}`,gif({before:[gce({disposal,user:true,delay:65535})]}));
  add('gif_disabled_transparency_index_ignored',gif({before:[gce({index:255})]}));
  add('gif_valid_transparency',gif({before:[gce({transparent:true,index:1})]}));
  add('gif_transparency_overflow',gif({before:[gce({transparent:true,index:2})]}),invalid);
  add('gif_local_palette_transparency_valid',gif({local:4,before:[gce({transparent:true,index:3})]}));
  add('gif_local_palette_supersedes_global',gif({global:4,local:2,before:[gce({transparent:true,index:3})]}),invalid);
  add('gif_gce_consumed_once',gif({local:4,before:[gce({transparent:true,index:3})],after:[frame()]}));
  add('gif_gce_crosses_comment_application_special',gif({before:[gce({transparent:true,index:1}),comment,application,special]}));
  add('gif_gce_not_consumed_by_special',gif({before:[gce({transparent:true,index:2}),special]}),invalid);
  for(const size of [0,1,3,5])add(`gif_gce_size_${size}`,gif({before:[Buffer.from([0x21,0xf9,size,...Array(size).fill(0),0])]}),invalid);
  const badTerm=gce();badTerm[7]=1;add('gif_gce_bad_terminator',gif({before:[badTerm]}),invalid);
  const reserved=gce();reserved[3]=32;add('gif_gce_reserved_bits',gif({before:[reserved]}),invalid);
  add('gif_duplicate_gce',gif({before:[gce(),gce()]}),invalid);
  add('gif_dangling_gce',gif({after:[gce()]}),invalid);
  add('gif_background_index_outside_two_color_palette',gif({width:2,background:255}),invalid);
  add('gif_uncovered_valid_background',gif({width:2,background:1}));
  add('gif_no_global_palette_background_ignored',gif({global:0,local:2,background:255}));
  add('gif_valid_opaque_application',gif({before:[application]}));
  for(const size of [10,12])add(`gif_application_header_size_${size}`,gif({before:[Buffer.from([0x21,0xff,size,...Array(size).fill(65),0])]}),invalid);
  add('gif_truncated_comment',Buffer.concat([gif().subarray(0,19),Buffer.from([0x21,0xfe,2,65])]),invalid);
  add('gif_unknown_special_valid',gif({before:[special]}));
  for(let disposal=4;disposal<=7;disposal++)add(`gif_disposal_${disposal}_unsupported`,gif({before:[gce({disposal})]}),unsupported);
  const plain=Buffer.from([0x21,0x01,12,0,0,0,0,1,0,1,0,1,1,0,1,1,65,0]);
  add('gif_plain_text_unsupported',gif({before:[plain]}),unsupported);
  for(const label of [0x02,0x80])add(`gif_unknown_graphic_control_${label}`,gif({before:[Buffer.from([0x21,label,1,0,0])]}),unsupported);
  return cases;
}
