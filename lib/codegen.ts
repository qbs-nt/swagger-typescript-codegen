import {OpenApiSpec, PathItemObject, OperationObject} from '@loopback/openapi-v3-types';

import fs from 'fs';
import Mustache from 'mustache';
var beautify = require('js-beautify').js_beautify;
import lint from 'jshint'; // var lint = require('jshint').JSHINT;
import _ from 'lodash';

import { convertType } from './typescript';

// FIXME: compare with docs from readme
interface CodeGenOptions {
    swagger: OpenApiSpec;
    isES6?: boolean;
    esnext?: boolean;
    moduleName?: string;
    className?: string;
    imports?: any; // FIXME
    template?: {
        class?: string;
        method?: string;
        type?: string;
    }
    mustache?: any; // FIXME
}

interface TemplateVars {
    // FIXME: komplettieren
}

const defaultSuccessfulResponseType = 'void';

const normalizeName = (id: string) => {
    return id.replace(/\.|\-|\{|\}/g, '_');
};

const getPathToMethodName = (opts: CodeGenOptions, m, path: string) => {
    if(path === '/' || path === '') {
        return m;
    }

    // clean url path for requests ending with '/'
    var cleanPath = path.replace(/\/$/, '');

    var segments = cleanPath.split('/').slice(1);
    segments = _.transform(segments, function (result, segment) {
        if (segment[0] === '{' && segment[segment.length - 1] === '}') {
            segment = 'by' + segment[1].toUpperCase() + segment.substring(2, segment.length - 1);
        }
        result.push(segment);
    });
    var result = _.camelCase(segments.join('-'));
    return m.toLowerCase() + result[0].toUpperCase() + result.substring(1);
};

var versionRegEx = /\/api\/(v\d+)\//;

const getVersion = (path: string) => {
    var m = versionRegEx.exec(path);
    return (m && m[1]) || 'v0';
};

const getViewForSwagger2 = (opts: CodeGenOptions) => {
    const swagger = opts.swagger;
    if (swagger.swagger !== '2.0') {
        throw new Error('Only Swagger 2 specs are supported');
    }

    const authorizedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'COPY', 'HEAD', 'OPTIONS', 'LINK', 'UNLINK', 'PURGE', 'LOCK', 'UNLOCK', 'PROPFIND'];
    var data = {
        isES6: opts.isES6,
        description: swagger.info.description,
        isSecure: swagger.securityDefinitions !== undefined,
        moduleName: opts.moduleName,
        className: opts.className,
        imports: opts.imports,
        domain: (swagger.schemes && swagger.schemes.length > 0 && swagger.host && swagger.basePath) ? swagger.schemes[0] + '://' + swagger.host + swagger.basePath.replace(/\/+$/g,'') : '',
        methods: [],
        definitions: [],
        isSecureToken: undefined,
        isSecureApiKey: undefined,
        isSecureBasic: undefined
    };

    var latestMethodVersion = {}; /* Maps method name => max version */

    _.forEach(swagger.paths, function(api, path){
        let globalParams: PathItemObject['parameters'] = [];
        /**
         * @param {Object} op - meta data for the request
         * @param {string} m - HTTP method name - eg: 'get', 'post', 'put', 'delete'
         */
        _.forEach(api, function(op, m){
            if(m.toLowerCase() === 'parameters') {
                globalParams = op;
            }
        });
        _.forEach(api, function(op, m){
            var M = m.toUpperCase();
            if(M === '' || authorizedMethods.indexOf(M) === -1) {
                return;
            }

            // Ignore deprecated endpoints
            if (op.deprecated) {
                return;
            }

            var secureTypes = [];
            if(swagger.securityDefinitions !== undefined || op.security !== undefined) {
                var mergedSecurity = _.merge([], swagger.security, op.security).map(function(security: OperationObject['security']){
                    return Object.keys(security || []);
                });
                if(swagger.securityDefinitions) {
                    for(var sk in swagger.securityDefinitions) {
                        if (mergedSecurity.join(',').indexOf(sk) !== -1){
                            secureTypes.push(swagger.securityDefinitions[sk].type);
                        }
                    }
                }
            }

            var successfulResponseTypeIsRef = false;
            var successfulResponseType;
            try {
                const convertedType = convertType(op.responses['200'], swagger);

                if(convertedType.target){
                    successfulResponseTypeIsRef = true;
                }
    
                successfulResponseType = convertedType.target || convertedType.tsType || defaultSuccessfulResponseType;
            } catch (error) {
                successfulResponseType = defaultSuccessfulResponseType;
            }

            var version = getVersion(path);
            var intVersion = parseInt(version.substr(1));

            var method = {
                path: path,
                pathFormatString: path.replace(/{/g, '${parameters.'),
                className: opts.className,
                methodName:  op.operationId ? normalizeName(op.operationId) : getPathToMethodName(opts, m, path),
                version: version,
                intVersion: intVersion,
                method: M,
                isGET: M === 'GET',
                isPOST: M === 'POST',
                summary: op.description || op.summary,
                externalDocs: op.externalDocs,
                isSecure: swagger.security !== undefined || op.security !== undefined,
                isSecureToken: secureTypes.indexOf('oauth2') !== -1,
                isSecureApiKey: secureTypes.indexOf('apiKey') !== -1,
                isSecureBasic: secureTypes.indexOf('basic') !== -1,
                parameters: [],
                headers: [],
                successfulResponseType,
                successfulResponseTypeIsRef
            };

            latestMethodVersion[method.methodName] = Math.max(latestMethodVersion[method.methodName] || 0, intVersion);

            if(method.isSecure && method.isSecureToken) {
                data.isSecureToken = method.isSecureToken;
            }

            if(method.isSecure && method.isSecureApiKey) {
                data.isSecureApiKey = method.isSecureApiKey;
            }

            if(method.isSecure && method.isSecureBasic) {
                data.isSecureBasic = method.isSecureBasic;
            }

            var produces = op.produces || swagger.produces;
            if(produces) {
                method.headers.push({
                  name: 'Accept',
                  value: `'${produces.map(function(value) { return value; }).join(', ')}'`,
                });
            }

            var consumes = op.consumes || swagger.consumes;
            if(consumes) {
                var preferredContentType = consumes[0] || '';
                method.headers.push({name: 'Content-Type', value: '\'' + preferredContentType + '\''});
            }

            var params = [];
            if(_.isArray(op.parameters)) {
                params = op.parameters;
            }
            params = params.concat(globalParams);
            _.forEach(params, function(parameter) {
                //Ignore parameters which contain the x-exclude-from-bindings extension
                if(parameter['x-exclude-from-bindings'] === true) {
                    return;
                }

                // Ignore headers which are injected by proxies & app servers
                // eg: https://cloud.google.com/appengine/docs/go/requests#Go_Request_headers
                if (parameter['x-proxy-header']) {
                    return;
                }
                if (_.isString(parameter.$ref)) {
                    var segments = parameter.$ref.split('/');
                    parameter = swagger.parameters[segments.length === 1 ? segments[0] : segments[2] ];
                }
                parameter.camelCaseName = _.camelCase(parameter.name);
                if(parameter.enum && parameter.enum.length === 1) {
                    parameter.isSingleton = true;
                    parameter.singleton = parameter.enum[0];
                }
                if(parameter.in === 'body'){
                    parameter.isBodyParameter = true;
                } else if(parameter.in === 'path'){
                    parameter.isPathParameter = true;
                } else if(parameter.in === 'query'){
                    if(parameter['x-name-pattern']){
                        parameter.isPatternType = true;
                        parameter.pattern = parameter['x-name-pattern'];
                    }
                    parameter.isQueryParameter = true;
                } else if(parameter.in === 'header'){
                    parameter.isHeaderParameter = true;
                } else if(parameter.in === 'formData'){
                    parameter.isFormParameter = true;
                }
                parameter.tsType = convertType(parameter, swagger);
                parameter.cardinality = parameter.required ? '' : '?';
                method.parameters.push(parameter);
            });
            data.methods.push(method);
        });
    });

    _.forEach(data.methods, function(method){
        method.isLatestVersion = (method.intVersion === latestMethodVersion[method.methodName]);
    });

    _.forEach(swagger.definitions, function(definition, name){
        data.definitions.push({
            name: name,
            description: definition.description,
            tsType: convertType(definition, swagger)
        });
    });

    return data;
};

// FIXME: changelog: remove third param "type" (resulted in browset set to true in lintOptions if "custom)
const enhanceCode = (source, opts: CodeGenOptions) => {
    var lintOptions = {
        browser: false, // FIXME type === 'custom',
        undef: true,
        strict: true,
        trailing: true,
        smarttabs: true,
        maxerr: 999
    };

    if (opts.esnext) {
        lintOptions.esnext = true;
    }

    if (opts.lint === true) {
        lint(source, lintOptions);
        lint.errors.forEach(function(error) {
            if (error.code[0] === 'E') {
                throw new Error(error.reason + ' in ' + error.evidence + ' (' + error.code + ')');
            }
        });
    }

    if (opts.beautify === undefined || opts.beautify === true) {
        var beautifyOptions = _.defaults(opts.beautifyOptions || {}, { indent_size: 4, max_preserve_newlines: 2 });
        return beautify(source, beautifyOptions);
    } else {
        return source;
    }
}

const defaultTemplatesDir = `${__dirname}/../templates`;

const readDefaultTemplate = (type: string) =>
    fs.readFileSync(`${defaultTemplatesDir}/${type}.mustache`, 'utf-8');


// FIXME: changelog: removed third param "type"
const transformToCodeWithMustache = (data: TemplateVars, opts: CodeGenOptions) => {
    const template = (opts.template || {}).class || readDefaultTemplate('class');

    const partials = {
        method: (opts.template || {}).method || readDefaultTemplate('method'),
        type: (opts.template || {}).type || readDefaultTemplate('type')
    };


    if (opts.mustache) {
        _.assign(data, opts.mustache);
    }

    // Ensure we don't encode special characters
    Mustache.escape = (value) => value;

    return Mustache.render(template, data, partials);
}

// FIXME: changelog: removed third param "type" (was only passed through to transformToCodeWithMustache and enhandeCode)
const getCode = (opts: CodeGenOptions) => 
    enhanceCode(
        transformToCodeWithMustache(
            getViewForSwagger2(opts),
            opts
        ),
        opts
    );

// FIXME: changelog removed getCustomCode()
// FIXME: changelog added getCode() (getTypescriptCode() is only an alias for getCode())
exports.CodeGen = {
    transformToViewData: getViewForSwagger2,
    transformToCodeWithMustache,
    getCode,
    getTypescriptCode: getCode,
};
