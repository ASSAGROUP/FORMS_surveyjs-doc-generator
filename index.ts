import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path"

enum DocEntryType {unknown, classType, interfaceType, functionType, variableType};
interface DocEntry {
  name?: string;
  entryType?: DocEntryType;
  className?: string;
  jsonName?: string;
  fileName?: string;
  documentation?: string;
  see?: any;
  type?: string;
  baseType?: string;
  allTypes?: string[];
  constructors?: DocEntry[];
  members?: DocEntry[];
  parameters?: DocEntry[];
  returnType?: string;
  pmeType?: string;
  hasSet?: boolean;
  isField?: boolean;
  isOptional?: boolean;
  jsonClassName?: string;
  isSerialized?: boolean;
  defaultValue?: any;
  serializedChoices?: any[];
  moduleName?: string;
}

var jsonObjMetaData: any = null;
export function setJsonObj(obj: any) {
  jsonObjMetaData = obj;
}

/** Generate documentation for all classes in a set of .ts files */
export function generateDocumentation(
  fileNames: string[],
  options: ts.CompilerOptions,
  docOptions: any = null
): void {
  const host = ts.createCompilerHost(options);
  // Build a program using the set of root file names in fileNames
  const program = ts.createProgram(fileNames, options, host);

  // Get the checker, we will use it to find more about classes
  let checker = program.getTypeChecker();
  /*
  const errors = ts.getPreEmitDiagnostics(program);
  if(errors.length > 0) {
      for(var i = 0; i < errors.length; i ++) {
        const er = errors[i];
        //console.log(er.messageText + (!!er.file ?  + "  " + er.file.fileName : ""));
      }
      //console.log("Errors: " + errors.length);
  }
  */
  let outputClasses: DocEntry[] = [];
  let outputPMEs: DocEntry[] = [];
  let pmesHash = {};
  let classesHash = {};
  let curClass: DocEntry = null;
  let curJsonName: string = null;
  let generateJSONDefinitionClasses = {};
  let dtsFileName = !!docOptions ? docOptions.dtsFileName : undefined;
  let generateDts = !!dtsFileName;
  let generateJSONDefinition = 
    !!docOptions && docOptions.generateJSONDefinition === true;
  let generateDocs = !docOptions && !generateDts || (!!docOptions && docOptions.generateDoc !== false);
  let outputDefinition = {};
  let dtsImports = {};
  let dtsImportDeclarations = {};
  let dtsFrameworksImportDeclarations = {};
  let dtsDeclarations = {};
  let dtsTypesParameters = {};
  let dtsTypesArgumentParameters = {};

  // Visit every sourceFile in the program
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.fileName.indexOf("node_modules") > 0) continue;
    // Walk the tree to search for classes
    ts.forEachChild(sourceFile, visit);
  }
  for (var key in classesHash) {
    setAllParentTypes(key);
  }
  if(generateDocs) {
    // print out the doc
    fs.writeFileSync(
      process.cwd() + "/docs/classes.json",
      JSON.stringify(outputClasses, undefined, 4)
    );
    fs.writeFileSync(
      process.cwd() + "/docs/pmes.json",
      JSON.stringify(outputPMEs, undefined, 4)
    );
  }
  if (generateJSONDefinition) {
    outputDefinition["$schema"] = "http://json-schema.org/draft-07/schema#";
    outputDefinition["title"] = "SurveyJS Library json schema";
    addClassIntoJSONDefinition("SurveyModel", true);
    fs.writeFileSync(
      process.cwd() + "/docs/surveyjs_definition.json",
      JSON.stringify(outputDefinition, undefined, 4)
    );
  }
  if(generateDts) {
    importDtsFiles(docOptions.dtsImports);
    prepareDtsInfo();
    fs.writeFileSync(getAbsoluteFileName(dtsFileName), dtsGetText());
  }
  return;
  function getAbsoluteFileName(name: string): string {
    return path.join(process.cwd(), name);
  }

  /** set allParentTypes */
  function setAllParentTypes(className: string) {
    if (!className) return;
    var cur = classesHash[className];
    if (cur.allTypes && cur.allTypes.length > 0) return;
    setAllParentTypesCore(cur);
  }
  function setAllParentTypesCore(cur: any) {
    cur.allTypes = [];
    cur.allTypes.push(cur.name);
    if (!cur.baseType) return;
    var baseClass = classesHash[cur.baseType];
    if (!baseClass) return;
    if (!baseClass.allTypes) {
      setAllParentTypesCore(baseClass);
    }
    for (var i = 0; i < baseClass.allTypes.length; i++) {
      cur.allTypes.push(baseClass.allTypes[i]);
    }
  }
  /** visit nodes finding exported classes */
  function visit(node: ts.Node) {
    // Only consider exported nodes
    if (!isNodeExported(node)) return;
    if(node.kind === ts.SyntaxKind.ExportDeclaration) {
      //const eNode: ts.ExportDeclaration = <any>node;
      //console.log(eNode.name);
    } else if (node.kind === ts.SyntaxKind.VariableStatement) {
      const vsNode = <ts.VariableStatement>node;
      if(vsNode.declarationList.declarations.length > 0) {
        const varNode = vsNode.declarationList.declarations[0];
        let symbol = checker.getSymbolAtLocation(
          (<ts.VariableDeclaration>varNode).name
        );
        if (!!symbol && (generateDts || isSymbolHasComments(symbol))) {
          visitVariableNode(varNode, symbol);
        }
      }
    } else if (node.kind === ts.SyntaxKind.ClassDeclaration) {
      // This is a top level class, get its symbol
      let symbol = checker.getSymbolAtLocation(
        (<ts.ClassDeclaration>node).name
      );
      if (generateDts || isSymbolHasComments(symbol)) {
        visitDocumentedNode(node, symbol);
      }
    } else if (node.kind === ts.SyntaxKind.InterfaceDeclaration) {
      // This is a top level class, get its symbol
      let symbol = checker.getSymbolAtLocation(
        (<ts.InterfaceDeclaration>node).name
      );
      if (generateDts || isSymbolHasComments(symbol)) {
        visitDocumentedNode(node, symbol);
      }
    } else if (node.kind === ts.SyntaxKind.ModuleDeclaration) {
      // This is a namespace, visit its children
      ts.forEachChild(node, visit);
    }
  }
  function visitVariableNode(node: ts.VariableDeclaration, symbol: ts.Symbol) {
    const entry = serializeSymbol(symbol);
    entry.entryType = DocEntryType.variableType;
    dtsDeclarations[entry.name] = entry;
    visitVariableProperties(entry, node);
  }
  function visitVariableProperties(entry: DocEntry, node: ts.VariableDeclaration) {
    if(!node.initializer) return;
    const children = (<any>node.initializer).properties;
    if(!Array.isArray(children)) return;
    for(var i = 0; i < children.length; i ++) {
      visitVariableMember(entry, children[i]);
    }
  }
  function visitVariableMember(entry: DocEntry, node: ts.Node) {
    let symbol = checker.getSymbolAtLocation(
      (<ts.ClassDeclaration>node).name
    );
    const memberEntry = serializeClass(symbol, node);
    if(memberEntry) {
      if(!entry.members) entry.members = [];
      entry.members.push(memberEntry);
      visitVariableProperties(memberEntry, <ts.VariableDeclaration>node);
    }
  }
  function visitDocumentedNode(node: ts.Node, symbol: ts.Symbol) {
    curClass = serializeClass(symbol, node);
    classesHash[curClass.name] = curClass;
    outputClasses.push(curClass);
    curJsonName = null;
    ts.forEachChild(node, visitClassNode);

    if (!curJsonName) return;
    curClass.jsonName = curJsonName;
    if (!jsonObjMetaData) return;
    var properties = jsonObjMetaData.getProperties(curJsonName);
    for (var i = 0; i < outputPMEs.length; i++) {
      if (outputPMEs[i].className == curClass.name) {
        var propName = outputPMEs[i].name;
        for (var j = 0; j < properties.length; j++) {
          if (properties[j].name == propName) {
            outputPMEs[i].isSerialized = true;
            if (properties[j].defaultValue)
              outputPMEs[i].defaultValue = properties[j].defaultValue;
            if (properties[j].choices)
              outputPMEs[i].serializedChoices = properties[j].choices;
            if (properties[j].className)
              outputPMEs[i].jsonClassName = properties[j].className;
            break;
          }
        }
      }
    }
  }
  function visitClassNode(node: ts.Node) {
    if (!isPMENodeExported(node)) return;
    var symbol = null;
    if (node.kind === ts.SyntaxKind.MethodDeclaration)
      symbol = checker.getSymbolAtLocation((<ts.MethodDeclaration>node).name);
    if (node.kind === ts.SyntaxKind.FunctionDeclaration)
      symbol = checker.getSymbolAtLocation((<ts.FunctionDeclaration>node).name);
    if (node.kind === ts.SyntaxKind.PropertyDeclaration)
      symbol = checker.getSymbolAtLocation((<ts.PropertyDeclaration>node).name);
    if (node.kind === ts.SyntaxKind.GetAccessor)
      symbol = checker.getSymbolAtLocation(
        (<ts.GetAccessorDeclaration>node).name
      );
    if (node.kind === ts.SyntaxKind.SetAccessor)
      symbol = checker.getSymbolAtLocation(
        (<ts.SetAccessorDeclaration>node).name
      );
    if (node.kind === ts.SyntaxKind.PropertySignature)
      symbol = checker.getSymbolAtLocation((<ts.PropertySignature>node).name);
    if (node.kind === ts.SyntaxKind.MethodSignature)
      symbol = checker.getSymbolAtLocation((<ts.MethodSignature>node).name);
    if (symbol) {
      var ser = serializeMethod(symbol, node);
      let fullName = ser.name;
      if (curClass) {
        ser.className = curClass.name;
        ser.jsonName = curClass.jsonName;
        fullName = curClass.name + "." + fullName;
        if(!curClass.members) curClass.members = [];
        curClass.members.push(ser);
      }
      ser.pmeType = getPMEType(node.kind);
      if(node.kind === ts.SyntaxKind.PropertySignature) {
        ser.isField = true;
        ser.isOptional = checker.isOptionalParameter(<any>node);
      }
      if (ser.type.indexOf("Event") === 0) ser.pmeType = "event";
      if (node.kind === ts.SyntaxKind.GetAccessor) {
        let serSet = pmesHash[fullName];
        if (serSet) {
          ser.hasSet = serSet.hasSet;
        } else ser.hasSet = false;
      }
      if (node.kind === ts.SyntaxKind.SetAccessor) {
        let serGet = pmesHash[fullName];
        if (serGet) serGet.hasSet = true;
        ser = null;
      }
      if (ser) {
        if (!ser.parameters) ser.parameters = [];
        pmesHash[fullName] = ser;
        outputPMEs.push(ser);
      }
      if (ser && ser.name === "getType") {
        curJsonName = getJsonTypeName(<ts.FunctionDeclaration>node);
      }
      if (isSymbolHasComments(symbol)) {
      }
    }
  }
  function getJsonTypeName(node: ts.FunctionDeclaration): string {
    let body = (<ts.FunctionDeclaration>node).getFullText();
    if (body) {
      var pos = body.indexOf('return "');
      if (pos > 0) {
        body = body.substr(pos + 'return "'.length);
        pos = body.indexOf('"');
        return body.substr(0, pos);
      }
    }
    return null;
  }
  function getPMEType(nodeKind: ts.SyntaxKind) {
    if (nodeKind === ts.SyntaxKind.MethodDeclaration) return "method";
    if (nodeKind === ts.SyntaxKind.FunctionDeclaration) return "function";
    return "property";
  }
  function getTypeOfSymbol(symbol: ts.Symbol): ts.Type {
    if (symbol.valueDeclaration)
      return checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration);
    return checker.getDeclaredTypeOfSymbol(symbol);
  }
  /** Serialize a symbol into a json object */

  function serializeSymbol(symbol: ts.Symbol): DocEntry {
    const type = getTypeOfSymbol(symbol);
    const docParts = symbol.getDocumentationComment();
    const res = {
      name: symbol.getName(),
      documentation: !!docParts ? ts.displayPartsToString(docParts) : "",
      type: checker.typeToString(type),
    };
    var jsTags = symbol.getJsDocTags();
    if (jsTags) {
      var seeArray = [];
      for (var i = 0; i < jsTags.length; i++) {
        if (jsTags[i].name == "see") {
          seeArray.push(jsTags[i].text);
        }
      }
      if (seeArray.length > 0) {
        res["see"] = seeArray;
      }
    }
    return res;
  }

  /** Serialize a class symbol information */
  function serializeClass(symbol: ts.Symbol, node: ts.Node) {
    let details = serializeSymbol(symbol);
    if(node.kind === ts.SyntaxKind.InterfaceDeclaration) {
      details.entryType = DocEntryType.interfaceType;
    }
    if (node.kind !== ts.SyntaxKind.ClassDeclaration) return details;
    setTypeParameters(details.name, node);
    // Get the construct signatures
    let constructorType = checker.getTypeOfSymbolAtLocation(
      symbol,
      symbol.valueDeclaration
    );
    details.entryType = DocEntryType.classType;
    details.constructors = constructorType
      .getConstructSignatures()
      .map(serializeSignature);
    const firstHeritageClauseType = getFirstHeritageClauseType(<ts.ClassDeclaration>node);
    details.baseType = getBaseType(firstHeritageClauseType);
    setTypeParameters(details.baseType, firstHeritageClauseType, details.name);
    return details;
  }
  function getFirstHeritageClauseType(node: ts.ClassDeclaration): ts.ExpressionWithTypeArguments {
    if (!node || !node.heritageClauses || node.heritageClauses.length < 1) return undefined;
    const firstHeritageClause = node.heritageClauses[0];
    return firstHeritageClause.types[0];
  }
  function getBaseType(firstHeritageClauseType: ts.ExpressionWithTypeArguments): string {
    if(!firstHeritageClauseType) return "";
    const extendsType = checker.getTypeAtLocation(
      firstHeritageClauseType.expression
    );
    if (extendsType && extendsType.symbol) 
      return extendsType.symbol.name;
    const expression: any = firstHeritageClauseType.expression;
    if(!!expression.text) return expression.text;
    if(!!expression.expression && !!expression.expression.text && !!expression.name && !!expression.name.text)
      return expression.expression.text + "." + expression.name.text;
    return "";
  }
  function setTypeParameters(typeName: string, node: ts.Node, forTypeName?: string) {
    if(!typeName || !node) return;
    const parameters = getTypedParameters(node, !!forTypeName);
    if(!parameters) return;
    if(!forTypeName) {
      dtsTypesParameters[typeName] = parameters;
    } else {
      let args = dtsTypesArgumentParameters[typeName];
      if(!args) {
        args = {};
        dtsTypesArgumentParameters[typeName] = args;
      }
      args[forTypeName] = parameters;
    }
  }
  function getTypedParameters(node: ts.Node, isArgument: boolean): string[] {
    const params = getTypeParametersDeclaration(node, isArgument);
    if(!params || !Array.isArray(params)) return undefined;
    const res = [];
    for(var i = 0; i < params.length; i ++) {
      const name = getTypeParameterName(params[i], isArgument);
      const extendsType = getTypeParameterConstrains(params[i]); 
      res.push(name + extendsType);
    }
    return res.length > 0 ? res : undefined;
  }
  function getTypeParameterName(node: any, isArgument: boolean): string {
    let symbol = checker.getSymbolAtLocation(isArgument? (<any>node).typeName : node.name);
    if (!!symbol && symbol.name) return symbol.name;
    return "any";
  }
  function getTypeParameterConstrains(node: any): string {
    if(!node.default || !node.constraint) return "";
    const first = getTypeParameterName(node.default, true);
    const second = getTypeParameterName(node.constraint, true);
    if(first == "any" || second == "any") return undefined;
    return " extends " + first + " = " + second;
  }
  function getTypeParametersDeclaration(node: any, isArgument: boolean): ts.NodeArray<ts.TypeParameterDeclaration> {
    if(!isArgument && !!node.typeParameters) return node.typeParameters;
    if(isArgument && !!node.typeArguments) return node.typeArguments;
    return undefined;
  }

  /** Serialize a method symbol infomration */
  function serializeMethod(symbol: ts.Symbol, node: ts.Node) {
    let details = serializeSymbol(symbol);
    if (
      node.kind === ts.SyntaxKind.MethodDeclaration ||
      node.kind === ts.SyntaxKind.FunctionDeclaration
    ) {
      let signature = checker.getSignatureFromDeclaration(
        <ts.SignatureDeclaration>node
      );
      let funDetails = serializeSignature(signature);
      details.parameters = funDetails.parameters;
      details.returnType = funDetails.returnType;
    }
    return details;
  }

  /** Serialize a signature (call or construct) */
  function serializeSignature(signature: ts.Signature) {
    const params = signature.parameters;
    const res = {
      parameters: params.map(serializeSymbol),
      returnType: checker.typeToString(signature.getReturnType()),
      documentation: ts.displayPartsToString(
        signature.getDocumentationComment()
      ),
    };
    for(var i = 0; i < params.length; i ++) {
      const node: any = params[i].valueDeclaration;
      if(!!node) {
        res.parameters[i].isOptional = checker.isOptionalParameter(node);
      }
    }
    return res;
  }

  /** True if this is visible outside this file, false otherwise */
  function isNodeExported(node: ts.Node): boolean {
    return (
      (node.flags & ts.NodeFlags["Export"]) !== 0 ||
      (node.parent && node.parent.kind === ts.SyntaxKind.SourceFile)
    );
  }
  function isPMENodeExported(node: ts.Node): boolean {
    let modifier = ts.getCombinedModifierFlags(node);
    if ((modifier & ts.ModifierFlags.Public) !== 0) return true;
    if(node.kind === ts.SyntaxKind.PropertyDeclaration) return true;
    var parent = node.parent;
    return parent && parent.kind === ts.SyntaxKind.InterfaceDeclaration;
  }
  /** True if there is a comment before declaration */
  function isSymbolHasComments(symbol: ts.Symbol): boolean {
    let com = symbol.getDocumentationComment();
    return com && com.length > 0;
  }
  function addClassIntoJSONDefinition(
    className: string,
    isRoot: boolean = false
  ) {
    if (className == "IElement") {
      className = "SurveyElement";
    }
    if (!!generateJSONDefinitionClasses[className]) return;
    generateJSONDefinitionClasses[className] = true;
    var cur = classesHash[className];
    if (!isRoot && (!cur || !hasSerializedProperties(className))) {
      addChildrenClasses(className);
      return;
    }
    if (!cur || (!isRoot && hasClassInJSONDefinition(className))) return;
    var root = outputDefinition;
    if (!isRoot) {
      if (!outputDefinition["definitions"]) {
        outputDefinition["definitions"] = {};
      }
      outputDefinition["definitions"][cur.jsonName] = {};
      root = outputDefinition["definitions"][cur.jsonName];
      root["$id"] = "#" + cur.jsonName;
    }
    root["type"] = "object";
    addPropertiesIntoJSONDefinion(cur, root);
    if (!isRoot) {
      addParentClass(cur, root);
      addChildrenClasses(cur.name);
    }
  }
  function addParentClass(cur: DocEntry, root: any) {
    if (!cur.baseType) return;
    addClassIntoJSONDefinition(cur.baseType);
    var parentClass = classesHash[cur.baseType];
    if (!!parentClass && hasClassInJSONDefinition(parentClass.jsonName)) {
      var properties = root["properties"];
      delete root["properties"];
      root["allOff"] = [
        { $ref: "#" + parentClass.jsonName },
        { properties: properties },
      ];
    }
  }
  function addChildrenClasses(className: string) {
    for (var i = 0; i < outputClasses.length; i++) {
      if (outputClasses[i].baseType == className) {
        addClassIntoJSONDefinition(outputClasses[i].name);
      }
    }
  }

  function hasClassInJSONDefinition(className: string) {
    return (
      !!outputDefinition["definitions"] &&
      !!outputDefinition["definitions"][className]
    );
  }
  function addPropertiesIntoJSONDefinion(cur: any, jsonDef: any) {
    for (var i = 0; i < outputPMEs.length; i++) {
      var property = outputPMEs[i];
      if (property.className !== cur.name || !property.isSerialized)
        continue;
      addPropertyIntoJSONDefinion(property, jsonDef);
    }
  }
  function hasSerializedProperties(className: string): boolean {
    for (var i = 0; i < outputPMEs.length; i++) {
      var property = outputPMEs[i];
      if (property.className == className && property.isSerialized) return true;
    }
    return false;
  }
  function addPropertyIntoJSONDefinion(property, jsonDef) {
    if (!jsonDef.properties) {
      jsonDef.properties = {};
    }
    var properties = jsonDef.properties;
    var typeName = property.type;
    var isArray = !!typeName && typeName.indexOf("[]") > -1;
    if (!!property.jsonClassName || isArray) {
      addClassIntoJSONDefinition(typeName.replace("[]", ""));
    }
    var typeInfo: any = getTypeValue(property);
    var propInfo: any = { type: typeInfo };
    if (isArray) {
      propInfo = { type: "array", items: typeInfo };
    }
    if (
      !!property.serializedChoices &&
      Array.isArray(property.serializedChoices) &&
      property.serializedChoices.length > 1
    ) {
      propInfo["enum"] = property.serializedChoices;
    }
    properties[property.name] = propInfo;
  }
  function getTypeValue(property: DocEntry): any {
    var propType = property.type;
    if (propType.indexOf("|") > 0) return ["boolean", "string"];
    if (propType == "any") return ["string", "numeric", "boolean"];
    if (propType == "string" || propType == "numeric" || propType == "boolean")
      return propType;
    var childrenTypes = [];
    addChildrenTypes(propType.replace("[]", ""), childrenTypes);
    if (childrenTypes.length == 1) return getReferenceType(childrenTypes[0]);
    if (childrenTypes.length > 1) {
      var res = [];
      for (var i = 0; i < childrenTypes.length; i++) {
        res.push(getReferenceType(childrenTypes[i]));
      }
      return res;
    }
    return getReferenceType(propType.replace("[]", ""));
  }
  function addChildrenTypes(type: string, childrenTypes: Array<string>) {
    if (type == "IElement") type = "SurveyElement";
    for (var i = 0; i < outputClasses.length; i++) {
      if (outputClasses[i].baseType == type) {
        var count = childrenTypes.length;
        addChildrenTypes(outputClasses[i].name, childrenTypes);
        if (count == childrenTypes.length) {
          childrenTypes.push(outputClasses[i].name);
        }
      }
    }
  }
  function getReferenceType(type: string): any {
    var curClass = classesHash[type];
    if (!curClass) return type;
    return { $href: "#" + curClass.jsonName };
  }
  function importDtsFiles(imports: Array<any>) {
    if(!Array.isArray(imports)) return;
    for(var i = 0; i < imports.length; i ++) {
      importDtsFile(imports[i].name, imports[i].file);
    }
  }
  function importDtsFile(moduleName: string, fileName: string) {
    let text: string = fs.readFileSync(getAbsoluteFileName(fileName), 'utf8');
    const regExStrs = [{regex: /(?<=export interface)(.*)(?={)/gm, type: DocEntryType.interfaceType}, 
      {regex: /(?<=export declare var)(.*)(?=:)/gm, type: DocEntryType.variableType}, 
      {regex: /(?<=export declare class)(.*)(?={)/gm, type: DocEntryType.classType}, 
      {regex: /(?<=export declare class)(.*)(?=extends)/gm, type: DocEntryType.classType},
      {regex: /(?<=export declare class)(.*)(?=implements)/gm, type: DocEntryType.classType},
      {regex: /(?<=export declare class)(.*)(?=<)/gm, type: DocEntryType.classType}];
    for(var i = 0; i < regExStrs.length; i ++) {
      const item = regExStrs[i];
      text.match(item.regex).forEach((name: string) => {
        if(!!name && !!name.trim()) {
          dtsImports[name.trim()] = {name: name.trim(), moduleName: moduleName, entryType: item.type};
        }
      });
    }
  }
  function prepareDtsInfo() {
    for(var key in classesHash) {
      proccessDtsClass(classesHash[key]);
    }
  }
  function proccessDtsClass(curClass: DocEntry) {
    dtsDeclarations[curClass.name] = curClass;
  }
  function dtsGetText(): string {
    const lines = [];
    dtsRenderDeclarations(lines);
    return lines.join("\n");
  }
  function dtsRenderDeclarations(lines: string[]) {
    const classes = [];
    const interfaces = [];
    const variables = [];

    for(var key in dtsDeclarations) {
      if(!!dtsImports[key]) continue;
      const cur = dtsDeclarations[key];
      if (cur.entryType === DocEntryType.classType) {
          classes.push(cur);
      }
      if (cur.entryType === DocEntryType.interfaceType) {
          interfaces.push(cur);
      }
      if (cur.entryType === DocEntryType.variableType) {
        variables.push(cur);
      } 
    }
    dtsSortClasses(classes);
    for (var i = 0; i < interfaces.length; i++) {
      dtsRenderDeclarationInterface(lines, interfaces[i]);
    }
    for(var i = 0; i < classes.length; i ++) {
      dtsRenderDeclarationClass(lines, classes[i]);
    }
    for(var i = 0; i < variables.length; i ++) {
      dtsRenderDeclarationVariable(lines, variables[i], 0);
    }
    dtsRenderImports(lines);
  }
  function dtsSortClasses(classes: DocEntry[]) {
    classes.sort((a: DocEntry, b: DocEntry) : number => {
      if(a.allTypes.indexOf(b.name) > -1) return 1;
      if(b.allTypes.indexOf(a.name) > -1) return -1;
      if(a.allTypes.length !== b.allTypes.length) {
        return a.allTypes.length > b.allTypes.length ? 1 : -1;
      }
      return  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  }
  function dtsRenderImports(lines: string[]) {
    const modules: any = {};
    for(key in dtsImportDeclarations) {
      const entry: DocEntry = dtsImportDeclarations[key];
      let arr = modules[entry.moduleName];
      if(!arr) {
        arr = [];
        modules[entry.moduleName] = arr;
      }
      arr.push(key);
    }
    const importLines: string[] =[];
    for(key in modules) {
      const arr: string[] = modules[key];
      while(arr.length > 0) {
        const renderedArr = arr.splice(0, 5);
        let str = "import { " + renderedArr.join(", ") + " } from \"" + key + "\";";
        importLines.push(str);
      }
    }
    for(var key in dtsFrameworksImportDeclarations) {
      importLines.push(dtsFrameworksImportDeclarations[key] + " from \"" + key + "\";");
    }
    if(importLines.length > 0) {
      lines.unshift("");
    }
    for(let i = importLines.length - 1; i >= 0; i --) {
      lines.unshift(importLines[i]);
    }
  }
  function dtsRenderDeclarationClass(lines: string[], entry: DocEntry) {
    if(entry.name === "default") return;
    dtsRenderDoc(lines, entry);
    let line = "export declare ";
    line += "class " + dtsGetType(entry.name) + dtsGetTypeGeneric(entry.name) + dtsRenderClassExtend(entry) + dtsGetTypeGeneric(entry.baseType, entry.name) + " {";
    lines.push(line);
    dtsRenderDeclarationConstructor(lines, entry);
    dtsRenderDeclarationBody(lines, entry);
    lines.push("}");
  }
  function dtsRenderDeclarationInterface(lines: string[], entry: DocEntry) {
    dtsRenderDoc(lines, entry);
    var line = "export interface " + dtsGetType(entry.name) + dtsGetTypeGeneric(entry.name) + " {";
    lines.push(line);
    dtsRenderDeclarationBody(lines, entry);
    lines.push("}");
  }
  function dtsRenderDeclarationVariable(lines: string[], entry: DocEntry, level: number) {
    dtsRenderDoc(lines, entry, level);
    var line = (level === 0 ? "export declare var " : dtsAddSpaces(level)) + entry.name + ": ";
    const hasMembers = Array.isArray(entry.members);
    const comma = level === 0 ? ";" : ",";
    line += hasMembers ? "{" : (dtsGetType(entry.type) + comma);
    lines.push(line);
    if(hasMembers) {
        for(var i = 0; i < entry.members.length; i ++) {
          if(dtsIsPrevMemberTheSame(entry.members, i)) continue;
          dtsRenderDeclarationVariable(lines, entry.members[i], level + 1);
        }
        lines.push(dtsAddSpaces(level) + "}" + comma);
    }
  }
  function dtsRenderClassExtend(cur: DocEntry): string {
    if(!cur.baseType) return "";
    if(!dtsGetHasClassType(cur.baseType)) return "";
    let entry: DocEntry = dtsDeclarations[cur.baseType];
    if(!entry) {
      entry = dtsImports[cur.baseType];
    }
    if(!!entry && entry.entryType === DocEntryType.interfaceType)
      return Array.isArray(cur.members) ? " implements " + cur.baseType : "";
    return  " extends " + cur.baseType;
  }
  function dtsRenderDeclarationBody(lines: string[], entry: DocEntry) {
    if(!Array.isArray(entry.members)) return;
    const members = [].concat(entry.members);
    dtsGetMissingMembersInClassFromInterface(entry, members);
    for(var i = 0; i < members.length; i ++) {
      if(dtsIsPrevMemberTheSame(members, i)) continue;
      const member = members[i];
      if(dtsHasMemberInBaseClasses(entry, member.name)) continue;
      dtsRenderDeclarationMember(lines, member);
    }
  }
  function dtsRenderDeclarationConstructor(lines: string[], entry: DocEntry) {
    if(!Array.isArray(entry.constructors)) return;
    for(var i = 0; i < entry.constructors.length; i ++) {
      const parameters = dtsGetParameters(entry.constructors[i]);
      lines.push(dtsAddSpaces() + "constructor(" + parameters + ");");
    }
  }
  function dtsRenderDeclarationMember(lines: string[], member: DocEntry) {
    if(member.pmeType === "function" || member.pmeType === "method") {
      dtsRenderDoc(lines, member, 1);
      const returnType = dtsGetType(member.returnType);
      const parameters = dtsGetParameters(member);
      lines.push(dtsAddSpaces() + member.name + "(" + parameters + "): " + returnType + ";");
    }
    if(member.pmeType === "property") {
      dtsRenderDoc(lines, member, 1);
      const propType = dtsGetType(member.type);
      if(member.isField) {
        lines.push(dtsAddSpaces() + member.name + (member.isOptional ? "?" : "") + ": " + propType + ";");  
      } else {
        lines.push(dtsAddSpaces() + "get " + member.name + "(): " + propType + ";");
        if(member.hasSet) {
          lines.push(dtsAddSpaces() + "set " + member.name + "(val: " + propType + ");");
        }
      }
    }
  }
  function dtsRenderDoc(lines: string[], entry: DocEntry, level: number = 0) {
    return; //TODO
    if(!entry.documentation) return;
    const docLines = entry.documentation.split("\n");
    lines.push(dtsAddSpaces(level) + "/*");
    for(var i = 0; i < docLines.length; i ++) {
      lines.push(dtsAddSpaces(level) + "* " + docLines[i]);
    }
    lines.push(dtsAddSpaces(level) + "*/");
  }
  function dtsGetMissingMembersInClassFromInterface(entry: DocEntry, members: Array<DocEntry>) {
    if(entry.entryType !== DocEntryType.classType || !entry.baseType) return;
    const parentEntry: DocEntry = dtsDeclarations[entry.baseType] ;
    if(!parentEntry || parentEntry.entryType !== DocEntryType.interfaceType || !Array.isArray(parentEntry.members)) return
    const membersHash = {};
    for(var i = 0; i < members.length; i ++) {
      membersHash[members[i].name] = members[i];
    }
    for(var i = 0; i < parentEntry.members.length; i ++) {
      const member = parentEntry.members[i];
      if(!membersHash[member.name]) {
        members.push(member);
      }
    }
  }
  function dtsGetType(type: string): string {
    if(!type) return "void";
    if(type.indexOf("|") > -1) {
      return type.indexOf("(") > -1 ? "any" : type;
    }
    let str = type.replace("[", "").replace("]", "");
    if(str === "number" || str === "boolean" || str === "string" || str === "any" || str === "void") return type;
    return dtsGetHasClassType(str) ? type : "any";
  }
  function dtsGetTypeGeneric(type: string, typeFor?: string): string {
    if(!type) return "";
    if(!typeFor) return dtsGetTypeGenericByParameters(dtsTypesParameters[type]);
    const args = dtsTypesArgumentParameters[type];
    if(!args) return "";
    return dtsGetTypeGenericByParameters(args[typeFor]);
  }
  function dtsGetTypeGenericByParameters(params: string[]): string {
    if(!Array.isArray(params)) return "";
    for(var i = 0; i < params.length; i ++) {
      dtsAddImportDeclaration(params[i]);
    }
    return "<" + params.join(", ") + ">";
  }
  function dtsGetHasClassType(type: string): boolean {
    if(dtsAddImportDeclaration(type)) return true;
    return !!dtsDeclarations[type];
  }
  function dtsAddImportDeclaration(type: string): boolean {
    if(!type) return false;
    if(type.indexOf("React.") === 0) {
      dtsFrameworksImportDeclarations["react"] = "import * as React";
      return true;
    }
    const entry = dtsImports[type];
    if(!entry) return false;
    dtsImportDeclarations[type] = entry;
    return true;
  }
  function dtsIsPrevMemberTheSame(members: Array<DocEntry>, index: number): boolean {
    return index > 0 && members[index].name === members[index - 1].name;
  }
  function dtsGetParameters(member: DocEntry): string {
    if(!Array.isArray(member.parameters)) return "";
    let strs  = [];
    const params = member.parameters;
    for(var i = 0; i < params.length; i ++) {
      const p = params[i];
      strs.push(p.name + (p.isOptional ? "?" : "") + ": " + dtsGetType(p.type));
    }
    return strs.join(", ");
  }
  function dtsHasMemberInBaseClasses(entry: DocEntry, name: string): boolean {
    if(!Array.isArray(entry.allTypes)) return false;
    for(var i = 1; i < entry.allTypes.length; i ++) {
      let parentEntry: DocEntry = dtsDeclarations[entry.allTypes[i]];
      if(parentEntry.entryType === DocEntryType.interfaceType) continue;
      if(dtsHasMember(parentEntry, name)) return true;
    }
    return false;
  }
  function dtsHasMember(entry: DocEntry, name: string): boolean {
    if(!entry.members) return false;
    for(var i = 0; i < entry.members.length; i ++) {
      if(entry.members[i].name === name) return true;
    }
    return false;
  }
  function dtsAddSpaces(level: number = 1): string {
    let str = "";
    for(var i = 0; i < level; i++) str+= "  ";
    return str;
  }
}
