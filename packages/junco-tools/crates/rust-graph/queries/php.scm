; Derived from tree-sitter-php 0.24.2 queries/tags.scm (MIT); junco additions below the marker.
(namespace_definition
  name: (namespace_name) @name) @definition.module

(interface_declaration
  name: (name) @name) @definition.interface

(trait_declaration
  name: (name) @name) @definition.interface

(class_declaration
  name: (name) @name) @definition.class

(class_interface_clause [(name) (qualified_name)] @name) @reference.implementation

(property_declaration
  (property_element (variable_name (name) @name))) @definition.field

(function_definition
  name: (name) @name) @definition.function

(method_declaration
  name: (name) @name) @definition.function

(object_creation_expression
  [
    (qualified_name (name) @name)
    (variable_name (name) @name)
  ]) @reference.class

(function_call_expression
  function: [
    (qualified_name (name) @name)
    (variable_name (name)) @name
  ]) @reference.call

(scoped_call_expression
  name: (name) @name) @reference.call

(member_call_expression
  name: (name) @name) @reference.call

; --- junco additions ---
(namespace_use_declaration (namespace_use_clause (qualified_name) @import.module)) @import
(base_clause (name) @name) @reference.extends
(include_expression (string (string_content) @import.module)) @import
(include_expression (encapsed_string (string_content) @import.module)) @import
(include_once_expression (string (string_content) @import.module)) @import
(include_once_expression (encapsed_string (string_content) @import.module)) @import
(require_expression (string (string_content) @import.module)) @import
(require_expression (encapsed_string (string_content) @import.module)) @import
(require_once_expression (string (string_content) @import.module)) @import
(require_once_expression (encapsed_string (string_content) @import.module)) @import
(function_call_expression function: (name) @name) @reference.call
