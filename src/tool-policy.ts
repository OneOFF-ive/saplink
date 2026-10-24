// Registration annotations and server-side write protection must use the same list.
export const writeTools = new Set([
  'run_atc',
  'run_unit_tests',
  'create_program',
  'create_function_group',
  'create_function_module',
  'create_transport_request',
  'update_source',
  'activate_objects'
]);
