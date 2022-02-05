import { cache } from "decorator-cache-getter";
import { raise, warn } from "../../utils/console";
import { NonNullNativeStruct } from "../../utils/native-struct";
import { levenshtein, shouldBeInstance } from "../decorators";
import { fromFridaValue, readGString, toFridaValue } from "../utils";

/** Represents a `MethodInfo`. */
class Il2CppMethod<R extends Il2Cpp.Method.ReturnType, A extends Il2Cpp.Parameter.Type[] | []> extends NonNullNativeStruct {
    /** Gets the class in which this method is defined. */
    @cache
    get class(): Il2Cpp.Class {
        return new Il2Cpp.Class(Il2Cpp.Api._methodGetClass(this));
    }

    /** Gets the flags of the current method. */
    @cache
    get flags(): number {
        return Il2Cpp.Api._methodGetFlags(this, NULL);
    }

    /** Gets the implementation flags of the current method. */
    @cache
    get implementationFlags(): number {
        const implementationFlagsPointer = Memory.alloc(Process.pointerSize);
        Il2Cpp.Api._methodGetFlags(this, implementationFlagsPointer);

        return implementationFlagsPointer.readU32();
    }

    /** */
    @cache
    get fridaSignature(): NativeCallbackArgumentType[] {
        const types: NativeCallbackArgumentType[] = [];

        for (const parameter of this.parameters) {
            types.push(parameter.type.fridaAlias);
        }

        if (!this.isStatic || Unity.isBelow2018_3_0) {
            types.unshift("pointer");
        }

        if (this.isInflated) {
            types.push("pointer");
        }

        return types;
    }

    /** Gets the amount of generic parameters of this generic method. */
    @cache
    get genericParameterCount(): number {
        if (!this.isGeneric) {
            return 0;
        }

        return this.object.method<Il2Cpp.Array, []>("GetGenericArguments").invoke().length;
    }

    /** Determines whether this method is external. */
    @cache
    get isExternal(): boolean {
        return !!Il2Cpp.Api._methodIsExternal(this);
    }

    /** Determines whether this method is generic. */
    @cache
    get isGeneric(): boolean {
        return !!Il2Cpp.Api._methodIsGeneric(this);
    }

    /** Determines whether this method is inflated (generic with a concrete type parameter). */
    @cache
    get isInflated(): boolean {
        return !!Il2Cpp.Api._methodIsInflated(this);
    }

    /** Determines whether this method is static. */
    @cache
    get isStatic(): boolean {
        return !Il2Cpp.Api._methodIsInstance(this);
    }

    /** Determines whether this method is synchronized. */
    @cache
    get isSynchronized(): boolean {
        return !!Il2Cpp.Api._methodIsSynchronized(this);
    }

    /** Gets the access modifier of this method. */
    get modifier(): string {
        return Il2Cpp.Api._methodGetModifier(this).readUtf8String()!;
    }

    /** Gets the name of this method. */
    @cache
    get name(): string {
        return Il2Cpp.Api._methodGetName(this).readUtf8String()!;
    }

    /** @internal */
    @cache
    get nativeFunction(): NativeFunction<any, any> {
        return new NativeFunction(this.virtualAddress, this.returnType.fridaAlias, this.fridaSignature as NativeFunctionArgumentType[]);
    }

    /** Gets the encompassing object of the current method. */
    @cache
    get object(): Il2Cpp.Object {
        return new Il2Cpp.Object(Il2Cpp.Api._methodGetObject(this, NULL));
    }

    /** Gets the amount of parameters of this method. */
    @cache
    get parameterCount(): number {
        return Il2Cpp.Api._methodGetParameterCount(this);
    }

    /** Gets the parameters of this method. */
    @cache
    get parameters(): Il2Cpp.Parameter[] {
        return Array.from(Array(this.parameterCount), (_, i) => {
            const parameterName = Il2Cpp.Api._methodGetParameterName(this, i).readUtf8String()!;
            const parameterType = Il2Cpp.Api._methodGetParameterType(this, i);
            return new Il2Cpp.Parameter(parameterName, i, new Il2Cpp.Type(parameterType));
        });
    }

    /** Gets the relative virtual address (RVA) of this method. */
    @cache
    get relativeVirtualAddress(): NativePointer {
        return this.virtualAddress.sub(Il2Cpp.module.base);
    }

    /** Gets the return type of this method. */
    @cache
    get returnType(): Il2Cpp.Type {
        return new Il2Cpp.Type(Il2Cpp.Api._methodGetReturnType(this));
    }

    /** Gets the virtual address (VA) to this method. */
    @cache
    get virtualAddress(): NativePointer {
        return Il2Cpp.Api._methodGetPointer(this);
    }

    /** Replaces the body of this method. */
    set implementation(block: (this: Il2Cpp.Class | Il2Cpp.Object, ...parameters: A) => R) {
        if (this.virtualAddress.isNull()) {
            raise(`Cannot implementation for ${this.class.type.name}.${this.name}: pointer is null.`);
        } else if (this.isExternal) {
            warn(`Skipping implementation for ${this.class.type.name}.${this.name}: method is external.`);
            return;
        }

        const replaceCallback: NativeCallbackImplementation<any, any> = (...args: any[]): any => {
            const startIndex = +!this.isStatic | +Unity.isBelow2018_3_0;

            const result = block.call(
                this.isStatic ? this.class : new Il2Cpp.Object(args[0]),
                ...(this.parameters.map((e, i) => fromFridaValue(args[i + startIndex], e.type)) as A)
            );

            if (typeof result != "undefined") {
                return toFridaValue(result);
            }
        };

        this.restoreImplementation();
        try {
            Interceptor.replace(
                this.virtualAddress,
                new NativeCallback(replaceCallback, this.returnType.fridaAlias, this.fridaSignature as NativeCallbackArgumentType[])
            );
        } catch (e: any) {
            warn(`Skipping implementation for ${this.class.type.name}.${this.name}: ${e.message}.`);
        }
    }

    /** Creates a generic instance of the current generic method. */
    inflate(...classes: Il2Cpp.Class[]): Il2Cpp.Method {
        if (!this.isGeneric) {
            raise(`${this.name} it's not generic, so it cannot be inflated.`);
        }

        if (this.genericParameterCount != classes.length) {
            raise(`${this.name} has ${this.genericParameterCount} generic parameter(s), but ${classes.length} classes were supplied.`);
        }

        const types = classes.map(klass => klass.type.object);
        const typeArray = Il2Cpp.Array.from(Il2Cpp.Image.corlib.class("System.Type"), types);

        // TODO: typeArray leaks
        return this.inflateRaw(typeArray);
    }

    /** @internal */
    inflateRaw(typeArray: Il2Cpp.Array<Il2Cpp.Object>): Il2Cpp.Method {
        const inflatedMethodObject = this.object
            .method<Il2Cpp.Object, [Il2Cpp.Array<Il2Cpp.Object>]>("MakeGenericMethod", 1)
            .invoke(typeArray);

        return new Il2Cpp.Method(Il2Cpp.Api._methodGetFromReflection(inflatedMethodObject));
    }

    /** Invokes this method. */
    @shouldBeInstance(false)
    invoke(...parameters: A): R {
        return this.invokeRaw(NULL, ...parameters);
    }

    /** @internal */
    invokeRaw(instance: NativePointerValue, ...parameters: A): R {
        if (this.parameterCount != parameters.length) {
            raise(`${this.name} requires ${this.parameterCount} parameters, but ${parameters.length} were supplied.`);
        }

        const allocatedParameters = parameters.map(toFridaValue);

        if (!this.isStatic || Unity.isBelow2018_3_0) {
            allocatedParameters.unshift(instance);
        }

        if (this.isInflated) {
            allocatedParameters.push(this.handle);
        }

        const returnValue = Il2Cpp.try(() => this.nativeFunction(...allocatedParameters));
        return fromFridaValue(returnValue, this.returnType) as R;
    }

    /** Gets the parameter with the given name. */
    @levenshtein("parameters")
    parameter(name: string): Il2Cpp.Parameter {
        return this.tryParameter(name)!;
    }

    /** Restore the original method implementation. */
    restoreImplementation(): void {
        Interceptor.revert(this.virtualAddress);
        Interceptor.flush();
    }

    /** @internal */
    @shouldBeInstance(true)
    withHolder(instance: Il2Cpp.Object): Il2Cpp.Method<R, A> {
        return new Proxy(this, {
            get(target: Il2Cpp.Method<R, A>, property: keyof Il2Cpp.Method): any {
                if (property == "invoke") {
                    return target.invokeRaw.bind(target, instance.handle);
                } else if (property == "inflate") {
                    return function (...classes: Il2Cpp.Class[]) {
                        return target.inflate(...classes).withHolder(instance);
                    };
                }

                return Reflect.get(target, property);
            }
        });
    }

    /** Gets the parameter with the given name. */
    tryParameter(name: string): Il2Cpp.Parameter | undefined {
        return this.parameters.find(e => e.name == name);
    }

    override toString(): string {
        return readGString(Il2Cpp.Api._toString(this, Il2Cpp.Api._methodToString))!;
    }
}

Reflect.set(Il2Cpp, "Method", Il2CppMethod);

declare global {
    namespace Il2Cpp {
        class Method<
            R extends Il2Cpp.Method.ReturnType = Il2Cpp.Method.ReturnType,
            A extends Il2Cpp.Parameter.Type[] | [] = any[]
        > extends Il2CppMethod<R, A> {}
        namespace Method {
            type ReturnType = void | Il2Cpp.Field.Type;

            const enum Attributes {
                MemberAccessMask = 0x0007,
                PrivateScope = 0x0000,
                Private = 0x0001,
                FamANDAssem = 0x0002,
                Assembly = 0x0003,
                Family = 0x0004,
                FamORAssem = 0x0005,
                Public = 0x0006,
                Static = 0x0010,
                Final = 0x0020,
                Virtual = 0x0040,
                HideBySig = 0x0080,
                CheckAccessOnOverride = 0x0200,
                VtableLayoutMask = 0x0100,
                ReuseSlot = 0x0000,
                NewSlot = 0x0100,
                Abstract = 0x0400,
                SpecialName = 0x0800,
                PinvokeImpl = 0x2000,
                UnmanagedExport = 0x0008,
                RTSpecialName = 0x1000,
                ReservedMask = 0xd000,
                HasSecurity = 0x4000,
                RequireSecObject = 0x8000
            }

            const enum ImplementationAttribute {
                CodeTypeMask = 0x0003,
                IntermediateLanguage = 0x0000,
                Native = 0x0001,
                OptimizedIntermediateLanguage = 0x0002,
                Runtime = 0x0003,
                ManagedMask = 0x0004,
                Unmanaged = 0x0004,
                Managed = 0x0000,
                ForwardRef = 0x0010,
                PreserveSig = 0x0080,
                InternalCall = 0x1000,
                Synchronized = 0x0020,
                NoInlining = 0x0008,
                AggressiveInlining = 0x0100,
                NoOptimization = 0x0040,
                SecurityMitigations = 0x0400,
                MaxMethodImplVal = 0xffff
            }
        }
    }
}
