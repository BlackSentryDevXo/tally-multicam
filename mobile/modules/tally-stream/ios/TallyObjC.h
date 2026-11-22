//
//  TallyObjC.h
//  TallyStream
//
//  AVFoundation setters raise NSInvalidArgumentException on rejected values (e.g. an
//  unsupported output buffer size), which Swift cannot catch. This runs a block inside an
//  Objective-C @try/@catch and returns the exception text, or nil on success.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

FOUNDATION_EXPORT NSString *_Nullable TallyTryCatch(void (NS_NOESCAPE ^block)(void));

NS_ASSUME_NONNULL_END
