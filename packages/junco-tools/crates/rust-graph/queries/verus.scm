; Rust-derived captures over the vendored Verus grammar. verus_block contains real
; blocks, so the same patterns see wrapped exec, spec and proof declarations.
(struct_item name: (type_identifier) @name) @definition.class
(enum_item name: (type_identifier) @name) @definition.class
(union_item name: (type_identifier) @name) @definition.class
(type_item name: (type_identifier) @name) @definition.type
(associated_type name: (type_identifier) @name) @definition.type
(trait_item name: (type_identifier) @name) @definition.interface
(mod_item name: (identifier) @name) @definition.module
(macro_definition name: (identifier) @name) @definition.macro
(const_item name: (identifier) @name) @definition.constant
(static_item name: (identifier) @name) @definition.constant
(field_declaration name: (field_identifier) @name) @definition.field

; Requiring parameters after the name excludes Verus's second name field for
; named return values, e.g. fn next() -> (result: u64).
(function_item name: (identifier) @name parameters: (parameters)) @definition.function
(function_signature_item name: (identifier) @name) @definition.function
(declaration_list
  (function_item name: (identifier) @name parameters: (parameters)) @definition.method)
(declaration_list
  (function_signature_item name: (identifier) @name) @definition.method)

(impl_item type: (type_identifier) @name) @scope
(impl_item type: (scoped_type_identifier name: (type_identifier) @name)) @scope
(impl_item type: (generic_type type: (_) @name)) @scope
(impl_item trait: (_) @name) @reference.implementation

; Contracts, decreases measures, assert-by and proof blocks all contain ordinary
; expression nodes. Capture callees, not arbitrary identifiers or binder names.
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (scoped_identifier name: (identifier) @name)) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name)) @reference.call
(call_expression function: (generic_function function: (identifier) @name)) @reference.call
(call_expression function: (generic_function
  function: (scoped_identifier name: (identifier) @name))) @reference.call
(call_expression function: (generic_function
  function: (field_expression field: (field_identifier) @name))) @reference.call
(macro_invocation macro: (identifier) @name) @reference.call
(macro_invocation macro: (scoped_identifier name: (identifier) @name)) @reference.call

(parameter type: (_) @name) @reference.type
(function_item return_type: (_) @name) @reference.type
(function_signature_item return_type: (_) @name) @reference.type
(field_declaration type: (_) @name) @reference.type
(type_item type: (_) @name) @reference.type
(generic_type type: (_) @name) @reference.type
(reference_type type: (_) @name) @reference.type
(type_arguments (type_identifier) @name) @reference.type
(trait_bounds (type_identifier) @name) @reference.type
(struct_expression name: (_) @name) @reference.type

(use_declaration argument: (_) @import.module) @import
(mod_item "mod" @import.kind name: (identifier) @import.module !body) @import
