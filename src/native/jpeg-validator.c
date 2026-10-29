/* A finite, process-isolated libjpeg-turbo validation protocol.
 * See docs/strict-jpeg-resource-validation.md. No decoded pixels or decoder
 * messages leave this process. Build with one prefix's headers and libjpeg.a.
 */
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

#include <jpeglib.h>
#include <jerror.h>

#ifndef LIBJPEG_TURBO_VERSION
#error "This validator requires libjpeg-turbo headers"
#endif
#define STRINGIFY_INNER(value) #value
#define STRINGIFY(value) STRINGIFY_INNER(value)
#define INPUT_LIMIT ((size_t)16 * 1024 * 1024)
#define OUTPUT_LIMIT ((uint64_t)64 * 1024 * 1024)
#define ADDRESS_LIMIT ((rlim_t)512 * 1024 * 1024)
#define SCAN_LIMIT 100

enum outcome { INVALID = 10, UNSUPPORTED = 11, LIMIT = 12, INTERNAL = 13 };

static void write_receipt(const char *text)
{
  size_t left = strlen(text);
  while (left) {
    ssize_t written = write(STDOUT_FILENO, text, left);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) _exit(INTERNAL);
    text += written;
    left -= (size_t)written;
  }
}

static _Noreturn void fail(enum outcome result)
{
  switch (result) {
    case INVALID: write_receipt("{\"version\":1,\"status\":\"invalid\"}\n"); break;
    case UNSUPPORTED: write_receipt("{\"version\":1,\"status\":\"unsupported\"}\n"); break;
    case LIMIT: write_receipt("{\"version\":1,\"status\":\"limit\"}\n"); break;
    default: write_receipt("{\"version\":1,\"status\":\"internal\"}\n"); break;
  }
  _exit(result);
}

/* Never format msg_parm: decoder diagnostics can contain source text. */
static void fatal_error(j_common_ptr decoder)
{
  switch (decoder->err->msg_code) {
    case JERR_BAD_PRECISION:
    case JERR_NOT_COMPILED:
    case JERR_SOF_UNSUPPORTED: fail(UNSUPPORTED);
    case JERR_IMAGE_TOO_BIG:
    case JERR_OUT_OF_MEMORY:
    case JERR_NO_BACKING_STORE: fail(LIMIT);
    case JERR_BAD_LIB_VERSION:
    case JERR_BAD_STRUCT_SIZE: fail(INTERNAL);
    default: fail(INVALID);
  }
}

static void strict_message(j_common_ptr decoder, int level)
{
  (void)decoder;
  if (level < 0) fail(INVALID);
}

static void no_message(j_common_ptr decoder) { (void)decoder; }

static void process_limits(void)
{
  struct rlimit cpu = {4, 4};
  struct rlimit address = {ADDRESS_LIMIT, ADDRESS_LIMIT};
  struct rlimit current;
  if (getrlimit(RLIMIT_CPU, &current) != 0) fail(INTERNAL);
  if (current.rlim_cur < cpu.rlim_cur) cpu.rlim_cur = current.rlim_cur;
  if (current.rlim_max < cpu.rlim_max) cpu.rlim_max = current.rlim_max;
  if (setrlimit(RLIMIT_CPU, &cpu) != 0) fail(INTERNAL);
  if (getrlimit(RLIMIT_AS, &current) != 0) fail(INTERNAL);
  if (current.rlim_cur < address.rlim_cur) address.rlim_cur = current.rlim_cur;
  if (current.rlim_max < address.rlim_max) address.rlim_max = current.rlim_max;
  if (setrlimit(RLIMIT_AS, &address) != 0) {
#ifdef __APPLE__
    /* Darwin rejects RLIMIT_AS with EINVAL. This is not an RSS guarantee.
     * Keep the decoder/input/output/CPU bounds and the caller's wall deadline.
     */
    if (errno != EINVAL) fail(INTERNAL);
#else
    fail(INTERNAL);
#endif
  }
}

struct bounded_source {
  struct jpeg_source_mgr api;
  const JOCTET *end;
};

static void source_init(j_decompress_ptr decoder) { (void)decoder; }

static boolean source_empty(j_decompress_ptr decoder)
{
  (void)decoder;
  fail(INVALID); /* Physical EOF must never synthesize an EOI or missing data. */
}

static void source_skip(j_decompress_ptr decoder, long count)
{
  if (count < 0) fail(INVALID);
  if ((uint64_t)count > decoder->src->bytes_in_buffer) fail(INVALID);
  decoder->src->next_input_byte += (size_t)count;
  decoder->src->bytes_in_buffer -= (size_t)count;
}

static void source_finish(j_decompress_ptr decoder)
{
  struct bounded_source *source = (struct bounded_source *)decoder->src;
  if (source->api.bytes_in_buffer != 0 || source->api.next_input_byte != source->end)
    fail(INVALID);
}

static void scan_budget(j_decompress_ptr decoder)
{
  if (decoder->input_scan_number > SCAN_LIMIT) fail(LIMIT);
}

static void progress(j_common_ptr decoder)
{
  scan_budget((j_decompress_ptr)decoder);
}

static void supported_header(j_decompress_ptr decoder)
{
  if (!decoder->image_width || !decoder->image_height) fail(INVALID);
  if (decoder->image_width > 65535 || decoder->image_height > 65535 ||
      (uint64_t)decoder->image_width * decoder->image_height * 4 > OUTPUT_LIMIT)
    fail(LIMIT);
  if (decoder->data_precision != 8 || decoder->arith_code ||
      (decoder->num_components != 1 && decoder->num_components != 3))
    fail(UNSUPPORTED);
#if JPEG_LIB_VERSION >= 80
  if (decoder->block_size != DCTSIZE) fail(UNSUPPORTED);
#endif
  if ((decoder->num_components == 1 && decoder->jpeg_color_space != JCS_GRAYSCALE) ||
      (decoder->num_components == 3 && decoder->jpeg_color_space != JCS_RGB &&
       decoder->jpeg_color_space != JCS_YCbCr)) fail(UNSUPPORTED);
  if (!decoder->progressive_mode &&
      (decoder->comps_in_scan != decoder->num_components || decoder->Ss != 0 ||
       decoder->Se != 63 || decoder->Ah != 0 || decoder->Al != 0)) fail(UNSUPPORTED);
}

static void initial_scan_tables(j_decompress_ptr decoder)
{
  /* libjpeg-turbo's sequential initializer fills missing DC/AC 0/1 tables
   * for abbreviated Motion JPEG without a warning. Require the actual tables
   * before that initializer can run. The progressive initializer does not fill
   * defaults: later scans validate their own tables through libjpeg's normal
   * fatal checks. Do not require AC tables before a progressive DC-only scan.
   */
  for (int index = 0; index < decoder->comps_in_scan; index++) {
    jpeg_component_info *component = decoder->cur_comp_info[index];
    int quantization = component->quant_tbl_no;
    int dc = component->dc_tbl_no, ac = component->ac_tbl_no;
    if (quantization < 0 || quantization >= NUM_QUANT_TBLS ||
        !decoder->quant_tbl_ptrs[quantization]) fail(INVALID);
    if (!decoder->progressive_mode || (decoder->Ss == 0 && decoder->Ah == 0))
      if (dc < 0 || dc >= NUM_HUFF_TBLS || !decoder->dc_huff_tbl_ptrs[dc])
        fail(INVALID);
    if (!decoder->progressive_mode || decoder->Ss > 0)
      if (ac < 0 || ac >= NUM_HUFF_TBLS || !decoder->ac_huff_tbl_ptrs[ac])
        fail(INVALID);
  }
}

int main(int argc, char **argv)
{
  const char *version = STRINGIFY(LIBJPEG_TURBO_VERSION);
  char receipt[256];
  int receipt_size;
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    receipt_size = snprintf(receipt, sizeof(receipt),
      "{\"version\":1,\"decoder\":\"libjpeg-turbo\",\"decoder_version\":\"%s\"}\n", version);
    if (receipt_size < 0 || (size_t)receipt_size >= sizeof(receipt)) fail(INTERNAL);
    write_receipt(receipt);
    return 0;
  }
  if (argc != 1) fail(INTERNAL);
  process_limits();
  unsigned char *input = malloc(INPUT_LIMIT + 1);
  if (!input) fail(LIMIT);
  size_t length = 0;
  while (length <= INPUT_LIMIT) {
    ssize_t received = read(STDIN_FILENO, input + length, INPUT_LIMIT + 1 - length);
    if (received < 0 && errno == EINTR) continue;
    if (received < 0) fail(INTERNAL);
    if (!received) break;
    length += (size_t)received;
    if (length > INPUT_LIMIT) fail(LIMIT);
  }
  if (length < 2 || input[0] != 0xff || input[1] != 0xd8) fail(INVALID);

  struct jpeg_decompress_struct decoder;
  struct jpeg_error_mgr errors;
  struct jpeg_progress_mgr monitor;
  memset(&decoder, 0, sizeof(decoder));
  memset(&monitor, 0, sizeof(monitor));
  decoder.err = jpeg_std_error(&errors);
  errors.error_exit = fatal_error;
  errors.emit_message = strict_message;
  errors.output_message = no_message;
  jpeg_create_decompress(&decoder);
  decoder.mem->max_memory_to_use = (long)OUTPUT_LIMIT;
  monitor.progress_monitor = progress;
  decoder.progress = &monitor;
  struct bounded_source source;
  memset(&source, 0, sizeof(source));
  source.end = input + length;
  source.api.init_source = source_init;
  source.api.fill_input_buffer = source_empty;
  source.api.skip_input_data = source_skip;
  source.api.resync_to_restart = jpeg_resync_to_restart;
  source.api.term_source = source_finish;
  source.api.next_input_byte = input;
  source.api.bytes_in_buffer = length;
  decoder.src = &source.api;

  if (jpeg_read_header(&decoder, TRUE) != JPEG_HEADER_OK) fail(INVALID);
  supported_header(&decoder);
  initial_scan_tables(&decoder);
  decoder.scale_num = 1;
  decoder.scale_denom = 1;
  decoder.quantize_colors = FALSE;
  decoder.buffered_image = FALSE;
  decoder.raw_data_out = FALSE;
  decoder.out_color_space = decoder.num_components == 1 ? JCS_GRAYSCALE : JCS_RGB;
  if (!jpeg_start_decompress(&decoder)) fail(INVALID);
  scan_budget(&decoder);
  if (decoder.output_width != decoder.image_width ||
      decoder.output_height != decoder.image_height ||
      (decoder.output_components != 1 && decoder.output_components != 3)) fail(INTERNAL);
  size_t row_size = (size_t)decoder.output_width * (size_t)decoder.output_components;
  JSAMPROW row = malloc(row_size);
  if (!row) fail(LIMIT);
  while (decoder.output_scanline < decoder.output_height) {
    scan_budget(&decoder);
    if (jpeg_read_scanlines(&decoder, &row, 1) != 1) fail(INVALID);
  }
  /* jpeg_consume_input does not itself invoke the progress hook. */
  while (!jpeg_input_complete(&decoder)) {
    scan_budget(&decoder);
    if (jpeg_consume_input(&decoder) == JPEG_SUSPENDED) fail(INVALID);
    scan_budget(&decoder);
  }
  scan_budget(&decoder);
  if (decoder.progressive_mode) {
    if (!decoder.coef_bits) fail(INTERNAL);
    for (int component = 0; component < decoder.num_components; component++)
      for (int coefficient = 0; coefficient < DCTSIZE2; coefficient++)
        if (decoder.coef_bits[component][coefficient] != 0) fail(UNSUPPORTED);
  } else if (decoder.input_scan_number != 1) fail(UNSUPPORTED);
  source_finish(&decoder);
  unsigned int width = decoder.output_width, height = decoder.output_height;
  int scans = decoder.input_scan_number;
  /* Finish frees coef_bits, so all coverage checks must precede this call. */
  if (!jpeg_finish_decompress(&decoder)) fail(INVALID);
  source_finish(&decoder);
  jpeg_destroy_decompress(&decoder);
  free(row);
  free(input);
  receipt_size = snprintf(receipt, sizeof(receipt),
    "{\"version\":1,\"status\":\"valid\",\"width\":%u,\"height\":%u,\"scans\":%d,"
    "\"decoder\":\"libjpeg-turbo\",\"decoder_version\":\"%s\"}\n", width, height, scans, version);
  if (receipt_size < 0 || (size_t)receipt_size >= sizeof(receipt)) fail(INTERNAL);
  write_receipt(receipt);
  return 0;
}
