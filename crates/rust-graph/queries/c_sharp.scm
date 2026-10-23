; Derived from tree-sitter-c-sharp 0.23.5 queries/tags.scm (MIT); junco additions below the marker.
(class_declaration name: (identifier) @name) @definition.class

(class_declaration (base_list (_) @name)) @reference.extends

(interface_declaration name: (identifier) @name) @definition.interface

(interface_declaration (base_list (_) @name)) @reference.interface

(method_declaration name: (identifier) @name) @definition.method

(object_creation_expression type: (identifier) @name) @reference.class

(type_parameter_constraints_clause (identifier) @name) @reference.class

(type_parameter_constraint (type type: (identifier) @name)) @reference.class

(variable_declaration type: (identifier) @name) @reference.class

(invocation_expression function: (member_access_expression name: (identifier) @name)) @reference.send

(namespace_declaration name: (identifier) @name) @definition.module

; --- junco additions ---
(invocation_expression function: (identifier) @name) @reference.call
(using_directive (qualified_name) @import.module) @import
(using_directive (identifier) @import.module) @import
